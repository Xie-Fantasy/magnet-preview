import { test, expect, chromium } from '@playwright/test';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { unzipSync, strFromU8 } from 'fflate';

const extensionPath = resolve('.output/chrome-mv3');

interface ExtensionManifest {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  action?: { default_popup?: string };
  background?: { service_worker?: string };
}

async function readManifest(): Promise<ExtensionManifest> {
  const manifestPath = resolve(extensionPath, 'manifest.json');
  await access(manifestPath);
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as ExtensionManifest;
  if (!manifest.background?.service_worker)
    throw new Error('MV3 manifest does not declare background.service_worker.');
  await access(resolve(extensionPath, manifest.background.service_worker));
  return manifest;
}

async function launchExtension() {
  const profile = await mkdtemp(resolve(tmpdir(), 'magnet-preview-e2e-'));
  const diagnostics = {
    browserExecutable: chromium.executablePath(),
    channel: 'chromium',
    extensionPath,
    initialServiceWorkers: [] as string[],
    initialPages: [] as string[],
  };
  try {
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    diagnostics.initialServiceWorkers = context
      .serviceWorkers()
      .map((worker) => worker.url());
    diagnostics.initialPages = context.pages().map((page) => page.url());
    return { context, profile, diagnostics };
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw new Error(
      `Failed to launch Playwright bundled Chromium for the unpacked extension.\n${JSON.stringify(diagnostics, null, 2)}\n${String(error)}`,
    );
  }
}

function reopenExtensionProfile(profile: string) {
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function extensionWorker(
  context: import('@playwright/test').BrowserContext,
  diagnostics: Awaited<ReturnType<typeof launchExtension>>['diagnostics'],
) {
  const initialWorker = context.serviceWorkers()[0];
  if (initialWorker) return initialWorker;
  try {
    return await context.waitForEvent('serviceworker', { timeout: 10_000 });
  } catch (error) {
    const observed = {
      ...diagnostics,
      serviceWorkers: context.serviceWorkers().map((worker) => worker.url()),
      pages: context.pages().map((page) => page.url()),
    };
    throw new Error(
      `MV3 service worker was not registered after launching Playwright bundled Chromium with the unpacked extension.\n${JSON.stringify(observed, null, 2)}\n${String(error)}`,
    );
  }
}

async function hostileFixture() {
  const html = await readFile(
    resolve('tests/e2e/fixtures/hostile-page.html'),
    'utf8',
  );
  const server = createServer((_request, response) => response.end(html));
  await new Promise<void>((resolveServer) =>
    server.listen(0, '127.0.0.1', resolveServer),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/hostile.html`,
    close: () =>
      new Promise<void>((resolveServer) => server.close(() => resolveServer())),
  };
}

async function installPopupScanResponse(
  popup: import('@playwright/test').Page,
  response: unknown,
) {
  await popup.evaluate((scanResponse) => {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      sendMessage: (message: unknown) => Promise<unknown>;
    };
    const nativeSendMessage = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'scan-active-tab'
      )
        return Promise.resolve(scanResponse);
      return nativeSendMessage(message);
    };
  }, response);
}

test('loads the unpacked MV3 extension smoke', async () => {
  const manifest = await readManifest();
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions ?? []).toEqual([
    'activeTab',
    'scripting',
    'storage',
    'alarms',
  ]);
  expect(manifest.host_permissions ?? []).toEqual(['https://whatslink.info/*']);
  expect(manifest.action?.default_popup).toBe('popup.html');
  expect(manifest.background?.service_worker).toBe('background.js');

  const { context, profile, diagnostics } = await launchExtension();
  try {
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    const errors: string[] = [];
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      popup.getByRole('heading', { name: /Current page|当前页面/ }),
    ).toBeVisible();
    await expect(
      popup.getByRole('button', { name: /Scan current page|扫描当前页面/ }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('opens a usable toolbar action Popup instead of a provisional 25px view', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  try {
    const worker = await extensionWorker(context, diagnostics);
    const anchor = await context.newPage();
    const session = await context.newCDPSession(anchor);
    await worker.evaluate(() => chrome.action.openPopup());
    const targets = await session.send('Target.getTargets');
    const popupTarget = targets.targetInfos.find((target: { url: string }) =>
      target.url.endsWith('/popup.html'),
    );
    expect(popupTarget).toBeDefined();
    const { sessionId } = await session.send('Target.attachToTarget', {
      targetId: popupTarget!.targetId,
      flatten: false,
    });
    const measured = new Promise<{
      viewportWidth: number;
      viewportHeight: number;
      shellWidth: number;
      shellHeight: number;
      footerBottom: number;
    }>((resolveMeasured, rejectMeasured) => {
      const timer = setTimeout(
        () => rejectMeasured(new Error('Popup did not respond')),
        5000,
      );
      session.on('Target.receivedMessageFromTarget', (event) => {
        if (event.sessionId !== sessionId) return;
        const packet = JSON.parse(event.message) as {
          id?: number;
          result?: { result?: { value?: string } };
        };
        if (packet.id !== 1) return;
        clearTimeout(timer);
        const value = packet.result?.result?.value;
        if (!value) rejectMeasured(new Error('Popup layout was unavailable'));
        else resolveMeasured(JSON.parse(value));
      });
    });
    await session.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `JSON.stringify({
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            shellWidth: document.querySelector('.popup-shell').getBoundingClientRect().width,
            shellHeight: document.querySelector('.popup-shell').getBoundingClientRect().height,
            footerBottom: document.querySelector('.popup-footer').getBoundingClientRect().bottom
          })`,
          returnByValue: true,
        },
      }),
    });
    const layout = await measured;
    expect(layout.shellWidth).toBeGreaterThanOrEqual(500);
    expect(layout.shellHeight).toBeGreaterThanOrEqual(300);
    expect(layout.shellWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('exercises unpacked extension UI shell', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  try {
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    const errors: string[] = [];
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const myPagePromise = context.waitForEvent('page');
    await popup
      .getByRole('button', { name: /Open My page|打开我的页面/ })
      .click();
    const my = await myPagePromise;
    my.on('pageerror', (error) => errors.push(error.message));
    await expect(
      my.getByRole('heading', { name: /My page|我的页面/ }),
    ).toBeVisible();
    await my.getByRole('button', { name: /Cache|缓存/ }).click();
    await expect(
      my.getByRole('group', { name: /Retention policy|保留策略/ }),
    ).toBeVisible();
    await expect(my.getByText(/Previews: 0|预览: 0/)).toBeVisible();
    const cleanup = my.getByLabel('Automatic cache cleanup');
    await expect(cleanup).toHaveValue('24');
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (await chrome.alarms.get('magnetPreview.cacheCleanup'))
              ?.periodInMinutes,
        ),
      )
      .toBe(1440);
    await cleanup.selectOption('1');
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (await chrome.alarms.get('magnetPreview.cacheCleanup'))
              ?.periodInMinutes,
        ),
      )
      .toBe(60);
    await cleanup.selectOption('0');
    await expect
      .poll(() =>
        worker.evaluate(
          async () => await chrome.alarms.get('magnetPreview.cacheCleanup'),
        ),
      )
      .toBeUndefined();
    await cleanup.selectOption('24');
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (await chrome.alarms.get('magnetPreview.cacheCleanup'))
              ?.periodInMinutes,
        ),
      )
      .toBe(1440);
    await my.getByRole('button', { name: /Settings|设置/ }).click();
    await expect(my.getByRole('link', { name: 'WhatsLink' })).toHaveAttribute(
      'href',
      'https://whatslink.info/',
    );
    await my.getByLabel(/Theme|主题/).selectOption('dark');
    await expect(my.locator('html')).toHaveAttribute('data-theme', 'dark');
    await my.getByLabel(/Theme|主题/).selectOption('light');
    await expect(my.locator('html')).toHaveAttribute('data-theme', 'light');
    await my.getByLabel(/Theme|主题/).selectOption('system');
    await expect(my.locator('html')).toHaveAttribute('data-theme', 'light');
    await my.getByLabel(/Language|语言/).selectOption('en');
    await expect(my.locator('html')).toHaveAttribute('lang', 'en');
    await expect(my.getByRole('heading', { name: 'My page' })).toBeVisible();
    await expect(
      popup.getByRole('heading', { name: 'Current page' }),
    ).toBeVisible();
    await my.getByLabel('Language').selectOption('zh_CN');
    await expect(my.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(my).toHaveTitle(/我的页面/);
    await expect(popup.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(my.getByRole('heading', { name: '我的页面' })).toBeVisible();
    await expect(
      popup.getByRole('heading', { name: '当前页面', exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('keeps long Popup content inside a compact, scrollable unpacked-extension shell', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  try {
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    const errors: string[] = [];
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      popup.getByRole('button', { name: /Scan current page|扫描当前页面/ }),
    ).toBeVisible();

    const magnets = Array.from({ length: 20 }, (_, index) => {
      const infoHash = index.toString(16).padStart(40, '0').toUpperCase();
      return {
        magnet: {
          infoHash,
          displayName: `${'电影 🎬 '.repeat(20)}${index}`,
          originalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
          canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${infoHash}&dn=${encodeURIComponent(
            '电影 🎬 '.repeat(80),
          )}`,
        },
        occurrenceCount: index === 0 ? 4 : 1,
      };
    });
    for (const count of [0, 1, 5, 20]) {
      await installPopupScanResponse(popup, {
        kind: 'success',
        magnets: magnets.slice(0, count),
      });
      await popup
        .getByRole('button', { name: /Scan current page|扫描当前页面/ })
        .click();
      await expect(popup.getByRole('article')).toHaveCount(count);
    }

    const listLayout = await popup.evaluate(() => {
      const root = document.querySelector('.popup-shell') as HTMLElement;
      const content = document.querySelector('.popup-content') as HTMLElement;
      const cards = [...document.querySelectorAll('.resource-card')].map(
        (card) => {
          const cardBox = card.getBoundingClientRect();
          const actionBox = card
            .querySelector('button')
            ?.getBoundingClientRect();
          return {
            bottom: cardBox.bottom,
            left: cardBox.left,
            right: cardBox.right,
            top: cardBox.top,
            action: actionBox && {
              bottom: actionBox.bottom,
              left: actionBox.left,
              right: actionBox.right,
              top: actionBox.top,
              width: actionBox.width,
            },
          };
        },
      );
      return {
        contentClientHeight: content.clientHeight,
        contentScrollHeight: content.scrollHeight,
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        cards,
      };
    });
    expect(listLayout.rootScrollWidth).toBeLessThanOrEqual(
      listLayout.rootClientWidth,
    );
    expect(listLayout.contentScrollHeight).toBeGreaterThan(
      listLayout.contentClientHeight,
    );
    for (const [index, card] of listLayout.cards.entries()) {
      expect(card.action?.width).toBeGreaterThanOrEqual(60);
      expect(card.action?.left).toBeGreaterThanOrEqual(card.left);
      expect(card.action?.right).toBeLessThanOrEqual(card.right);
      if (index > 0)
        expect(card.top).toBeGreaterThanOrEqual(
          listLayout.cards[index - 1]?.bottom ?? 0,
        );
    }

    const cardGeometry = () =>
      popup.evaluate(() =>
        [...document.querySelectorAll('.resource-card')]
          .slice(0, 3)
          .map((card) => {
            const box = (selector?: string) => {
              const element = selector ? card.querySelector(selector) : card;
              const rect = element?.getBoundingClientRect();
              return (
                rect && {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                }
              );
            };
            return {
              card: box(),
              title: box('h2'),
              metadata: box('.resource-card-metadata'),
              status: box('.resource-card-status'),
              detail: box('.resource-detail-button'),
            };
          }),
      );
    await popup.locator('.resource-card').first().scrollIntoViewIfNeeded();
    const beforeHover = await cardGeometry();
    await popup.locator('.resource-card').first().hover();
    await expect(
      popup
        .locator('.resource-card')
        .first()
        .getByRole('button', {
          name: /Copy Magnet|复制 Magnet/,
        }),
    ).toBeVisible();
    expect(await cardGeometry()).toEqual(beforeHover);
    await popup.mouse.move(0, 0);
    await expect(
      popup
        .locator('.resource-card')
        .first()
        .getByRole('button', {
          name: /Copy Magnet|复制 Magnet/,
          includeHidden: true,
        }),
    ).toBeHidden();
    await popup.locator('.resource-card').first().focus();
    await expect(
      popup
        .locator('.resource-card')
        .first()
        .getByRole('button', {
          name: /Copy Magnet|复制 Magnet/,
        }),
    ).toBeVisible();
    expect(await cardGeometry()).toEqual(beforeHover);
    await popup.locator('.resource-detail-button').first().focus();
    expect(await cardGeometry()).toEqual(beforeHover);

    await popup.setViewportSize({ width: 380, height: 280 });
    const narrowLayout = await popup.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cardWidth: document
        .querySelector('.resource-card')
        ?.getBoundingClientRect().width,
    }));
    expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.viewport);
    expect(narrowLayout.cardWidth).toBeGreaterThan(0);

    await popup
      .getByRole('button', { name: /Open detail|查看详情/ })
      .first()
      .click();
    await expect(
      popup.getByRole('button', { name: /Copy Magnet|复制 Magnet/ }),
    ).toBeVisible();
    const detailLayout = await popup.evaluate(() => {
      const root = document.querySelector('.popup-shell') as HTMLElement;
      const value = document.querySelector('.detail-magnet') as HTMLElement;
      return {
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        valueClientWidth: value.clientWidth,
        valueScrollWidth: value.scrollWidth,
      };
    });
    expect(detailLayout.rootScrollWidth).toBeLessThanOrEqual(
      detailLayout.rootClientWidth,
    );
    expect(detailLayout.valueScrollWidth).toBeLessThanOrEqual(
      detailLayout.valueClientWidth,
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('retries one failed preview through the background manager without live traffic', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  await context.route(/^https?:/, (route) => route.abort());
  try {
    const worker = await extensionWorker(context, diagnostics);
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & { __retryCalls?: number };
      root.__retryCalls = 0;
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith('https://whatslink.info/api/v1/link?'))
          return nativeFetch(input, init);
        root.__retryCalls! += 1;
        if (root.__retryCalls! <= 2) return new Response('', { status: 503 });
        return new Response(
          JSON.stringify({
            error: '',
            name: 'Recovered preview',
            size: 4096,
            count: 1,
            screenshots: [],
          }),
          { status: 200 },
        );
      };
    });
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const infoHash = '0123456789ABCDEF0123456789ABCDEF01234567';
    const magnet = {
      infoHash,
      originalMagnet: `magnet:?xt=urn:btih:${infoHash}`,
      canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${infoHash}`,
    };
    await installPopupScanResponse(popup, {
      kind: 'success',
      magnets: [{ magnet, occurrenceCount: 1 }],
    });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await popup.getByRole('button', { name: 'Open detail' }).click();
    await expect(
      popup.getByRole('button', { name: 'Retry preview' }),
    ).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __retryCalls?: number })
            .__retryCalls,
      ),
    ).toBe(2);
    await popup.getByRole('button', { name: 'Retry preview' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Recovered preview' }),
    ).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __retryCalls?: number })
            .__retryCalls,
      ),
    ).toBe(3);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('requires consent and renders mixed previews through the real background path with zero live traffic', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  const externalRequests: string[] = [];
  context.on('request', (request) => {
    if (request.url().startsWith('https://whatslink.info/'))
      externalRequests.push(request.url());
  });
  await context.route(/^https?:/, (route) => route.abort());
  try {
    const worker = await extensionWorker(context, diagnostics);
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __providerCalls?: string[];
      };
      root.__providerCalls = [];
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith('https://whatslink.info/api/v1/link?'))
          return nativeFetch(input, init);
        const hash =
          new URL(url).searchParams.get('url')?.split('urn:btih:')[1] ?? '';
        root.__providerCalls?.push(hash);
        if (hash.endsWith('3')) return new Response('', { status: 404 });
        return new Response(
          JSON.stringify({
            error: '',
            name: 'Provider resource ' + hash.slice(-1),
            size: 2048,
            count: 2,
            screenshots: [],
          }),
          { status: 200 },
        );
      };
    });
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    const errors: string[] = [];
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const magnets = [1, 2, 3].map((n) => {
      const infoHash = n.toString(16).padStart(40, '0').toUpperCase();
      return {
        magnet: {
          infoHash,
          originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
          canonicalMagnet:
            'magnet:?xt=urn%3Abtih%3A' + infoHash + '&dn=PrivateName',
        },
        occurrenceCount: 1,
      };
    });
    await installPopupScanResponse(popup, { kind: 'success', magnets });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Enable online previews?' }),
    ).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls,
      ),
    ).toEqual([]);
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Provider resource 1' }),
    ).toBeVisible();
    await expect(
      popup.getByRole('heading', { name: 'Provider resource 2' }),
    ).toBeVisible();
    await expect(popup.getByText('Unavailable', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: 'Open detail' }).last().click();
    await expect(
      popup.getByText('No online preview is available for this resource.'),
    ).toBeVisible();
    await expect(
      popup.getByRole('button', { name: 'Retry preview' }),
    ).toBeVisible();
    await popup.getByRole('button', { name: 'Back', exact: true }).click();
    const calls = await worker.evaluate(
      () =>
        (globalThis as typeof globalThis & { __providerCalls?: string[] })
          .__providerCalls,
    );
    expect(calls).toEqual(magnets.map((item) => item.magnet.infoHash));
    await popup.getByRole('button', { name: 'Open detail' }).first().click();
    await expect(popup.getByText('2.00 KiB')).toBeVisible();
    await expect(
      popup.getByText('No screenshots are available for this resource.'),
    ).toBeVisible();
    await expect(
      popup.getByRole('link', { name: 'WhatsLink' }),
    ).toHaveAttribute('href', 'https://whatslink.info/');
    const myPagePromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open My page' }).click();
    const my = await myPagePromise;
    await my.getByRole('button', { name: 'Settings' }).click();
    const consentToggle = my.getByLabel('Online previews via WhatsLink');
    await expect(consentToggle).toBeChecked();
    await consentToggle.uncheck();
    await expect(popup.getByRole('link', { name: 'WhatsLink' })).toHaveCount(0);
    await expect(
      popup.getByText(magnets[0]!.magnet.canonicalMagnet),
    ).toBeVisible();
    await popup.getByRole('button', { name: 'Back' }).click();
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    const localMode = popup.locator('.popup-summary-mode');
    await expect(localMode).toContainText('Local only');
    await expect(localMode).toHaveAttribute(
      'title',
      'Online previews are off.',
    );
    await expect(
      localMode.getByRole('button', { name: 'Enable previews' }),
    ).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls,
      ),
    ).toEqual(magnets.map((item) => item.magnet.infoHash));
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('reuses a persisted preview after closing and reopening the extension profile', async () => {
  const launched = await launchExtension();
  const { profile, diagnostics } = launched;
  let context = launched.context;
  const infoHash = 'A'.repeat(40);
  const scanResponse = {
    kind: 'success',
    magnets: [
      {
        magnet: {
          infoHash,
          originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
          canonicalMagnet: 'magnet:?xt=urn%3Abtih%3A' + infoHash,
        },
        occurrenceCount: 1,
      },
    ],
  };
  try {
    await context.route(/^https?:/, (route) => route.abort());
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __providerCalls?: number;
      };
      root.__providerCalls = 0;
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) === 'https://whatslink.info/screenshot/offline.png') {
          const bytes = Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2cAAAAASUVORK5CYII=',
            ),
            (character) => character.charCodeAt(0),
          );
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        if (!String(input).startsWith('https://whatslink.info/api/v1/link?'))
          return nativeFetch(input, init);
        root.__providerCalls = (root.__providerCalls ?? 0) + 1;
        return new Response(
          JSON.stringify({
            error: '',
            name: 'Persisted offline fixture',
            size: 1024,
            count: 1,
            screenshots: [
              {
                screenshot: 'https://whatslink.info/screenshot/offline.png',
                time: 0,
              },
            ],
          }),
          { status: 200 },
        );
      };
    });
    let popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installPopupScanResponse(popup, scanResponse);
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Persisted offline fixture' }),
    ).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: number })
            .__providerCalls,
      ),
    ).toBe(1);
    await expect
      .poll(() =>
        popup.evaluate(async (key) => {
          const request = indexedDB.open('magnet-preview-cache', 1);
          return new Promise<boolean>((resolve, reject) => {
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const item = db
                .transaction('assets')
                .objectStore('assets')
                .get(key);
              item.onsuccess = () => {
                resolve(Boolean(item.result));
                db.close();
              };
              item.onerror = () => {
                reject(item.error);
                db.close();
              };
            };
          });
        }, infoHash + ':0'),
      )
      .toBe(true);

    await context.close();
    context = await reopenExtensionProfile(profile);
    await context.route(/^https?:/, (route) => route.abort());
    const restartedWorker = await extensionWorker(context, diagnostics);
    await restartedWorker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __providerCalls?: number;
      };
      root.__providerCalls = 0;
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith('https://whatslink.info/api/v1/link?'))
          return nativeFetch(input, init);
        root.__providerCalls = (root.__providerCalls ?? 0) + 1;
        throw new Error('Provider must not be requested on a cache hit');
      };
    });
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installPopupScanResponse(popup, scanResponse);
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Persisted offline fixture' }),
    ).toBeVisible();
    expect(
      await restartedWorker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: number })
            .__providerCalls,
      ),
    ).toBe(0);
    await popup.getByRole('button', { name: 'Open detail' }).click();
    const offlineImage = popup.getByRole('img', {
      name: /^Resource screenshot(?: \d+)?$/,
    });
    await expect
      .poll(() =>
        offlineImage.evaluate((node: HTMLImageElement) => ({
          width: node.naturalWidth,
          source: node.currentSrc.startsWith('blob:chrome-extension://'),
        })),
      )
      .toEqual({ width: 1, source: true });
    await popup.getByRole('button', { name: 'Save' }).click();
    await expect(popup.getByText('Saved to Favorites.')).toBeVisible();
    const myPagePromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open My page' }).click();
    const my = await myPagePromise;
    await expect(my.getByRole('button', { name: 'Open detail' })).toBeVisible();
    await expect(my.locator('.favorite-thumbnail')).toBeVisible();
    await expect
      .poll(() =>
        my
          .locator('.favorite-thumbnail')
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(1);
    await my.setViewportSize({ width: 480, height: 800 });
    await expect
      .poll(() =>
        my.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(my.locator('.favorite-sidebar')).toBeVisible();
    await my.setViewportSize({ width: 1280, height: 720 });
    await my.getByRole('button', { name: 'Cache' }).click();
    await expect(my.getByText('Previews: 1')).toBeVisible();
    const finiteGauge = my.getByRole('img', { name: /Capacity used/ });
    await expect(finiteGauge).toBeVisible();
    await expect(finiteGauge).toHaveAttribute('aria-label', / \/ 512 MiB/);
    await expect(finiteGauge).not.toHaveAttribute('aria-label', /∞/);
    const capacityMode = my.locator('select:has(option[value="unlimited"])');
    await capacityMode.selectOption('unlimited');
    const unlimitedGauge = my.getByRole('img', {
      name: /Current cache usage/,
    });
    await expect(
      my.getByRole('region', { name: 'Current cache usage' }),
    ).toBeVisible();
    await expect(unlimitedGauge).toBeVisible();
    await expect(unlimitedGauge.locator('canvas')).toBeVisible();
    expect(await unlimitedGauge.getAttribute('aria-label')).not.toContain('/');
    expect(await unlimitedGauge.getAttribute('aria-label')).not.toContain('∞');
    await capacityMode.selectOption('limited');
    await expect(my.getByLabel('Maximum MiB')).toHaveValue('512');
    for (const days of ['1', '3', '7', '14', '30']) {
      await my.getByLabel('Expire after last access').selectOption(days);
      await expect(my.getByLabel('Expire after last access')).toHaveValue(days);
    }
    await my.getByLabel('Expire after last access').selectOption('30');
    await expect(my.getByLabel('Expire after last access')).toHaveValue('30');
    await my.getByLabel('Expire after last access').selectOption('custom');
    await my.getByLabel('Custom days').fill('15');
    await my.getByLabel('Custom days').blur();
    await my.getByLabel('Maximum MiB').fill('4096');
    await my.getByLabel('Maximum MiB').blur();
    await expect(my.getByLabel('Adjust capacity')).toHaveValue('4096');
    await expect(my.getByLabel('Adjust capacity')).toBeEnabled();
    await my.evaluate(() => {
      const root = window as Window & { __policyWrites?: number };
      root.__policyWrites = 0;
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'settings')
          root.__policyWrites = (root.__policyWrites ?? 0) + 1;
        return Reflect.apply(originalPut, this, args);
      };
    });
    const slider = my.getByLabel('Adjust capacity');
    await slider.focus();
    await slider.press('End');
    await expect(my.getByLabel('Maximum MiB')).toHaveValue('8192');
    await expect
      .poll(() =>
        my.evaluate(
          () => (window as Window & { __policyWrites?: number }).__policyWrites,
        ),
      )
      .toBe(1);
    await my.getByLabel('Maximum MiB').fill('256');
    await my.getByLabel('Maximum MiB').blur();
    await expect(my.getByLabel('Adjust capacity')).toHaveValue('256');
    await my.reload();
    await my.getByRole('button', { name: 'Cache' }).click();
    await expect(my.getByLabel('Expire after last access')).toHaveValue(
      'custom',
    );
    await expect(my.getByLabel('Custom days')).toHaveValue('15');
    await expect(my.getByLabel('Maximum MiB')).toHaveValue('256');
    await my.getByRole('button', { name: 'Clear preview cache' }).click();
    await my.getByRole('button', { name: 'Delete cache' }).click();
    await expect(my.getByText('Previews: 0')).toBeVisible();
    await my.getByRole('button', { name: 'Favorites' }).click();
    await expect(
      my.getByRole('heading', { name: 'Persisted offline fixture' }),
    ).toBeVisible();
    const offlineHtmlDownload = my.waitForEvent('download');
    await my.getByRole('button', { name: 'Offline HTML' }).click();
    const offlineHtml = await offlineHtmlDownload;
    const offlineHtmlContent = await readFile(
      (await offlineHtml.path())!,
      'utf8',
    );
    expect(offlineHtmlContent).toContain('data:image/png;base64,');
    expect(offlineHtmlContent).not.toContain('whatslink.info/screenshot');
    expect(offlineHtmlContent).not.toMatch(
      /blob:|chrome-extension:\/\/|localhost|127\.0\.0\.1/,
    );
    const offlineZipDownload = my.waitForEvent('download');
    await my.getByRole('button', { name: 'Full ZIP' }).click();
    const offlineZip = await offlineZipDownload;
    const offlineEntries = unzipSync(
      new Uint8Array(await readFile((await offlineZip.path())!)),
    );
    expect(
      offlineEntries['collection/assets/' + infoHash + '/0.png'],
    ).toBeDefined();
    const zipData = strFromU8(offlineEntries['collection/data.json']!);
    expect(zipData).not.toContain('whatslink.info/screenshot');
    expect(zipData).not.toMatch(
      /blob:|chrome-extension:\/\/|localhost|127\.0\.0\.1/,
    );
    const offlineFolder = await mkdtemp(resolve(tmpdir(), 'magnet-images-'));
    try {
      const htmlPath = resolve(offlineFolder, 'standalone.html');
      await writeFile(htmlPath, offlineHtmlContent);
      const standalonePage = await context.newPage();
      await standalonePage.goto(pathToFileURL(htmlPath).href);
      await expect
        .poll(() =>
          standalonePage
            .getByRole('img')
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(1);
      const standaloneMode = standalonePage.getByRole('checkbox', {
        name: 'Color mode',
      });
      await standaloneMode.focus();
      await standaloneMode.press('Space');
      await expect(standaloneMode).toBeChecked();
      await expect(standalonePage.locator('.document')).toHaveCSS(
        'background-color',
        'rgb(20, 23, 21)',
      );
      await standalonePage.close();
      for (const [entry, bytes] of Object.entries(offlineEntries)) {
        const target = resolve(offlineFolder, entry);
        expect(target.startsWith(offlineFolder + sep)).toBe(true);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, bytes);
      }
      const zipPage = await context.newPage();
      await zipPage.goto(
        pathToFileURL(resolve(offlineFolder, 'collection/index.html')).href,
      );
      await expect
        .poll(() =>
          zipPage
            .getByRole('img')
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(1);
      const zipMode = zipPage.getByRole('checkbox', { name: 'Color mode' });
      await zipMode.focus();
      await zipMode.press('Space');
      await expect(zipMode).toBeChecked();
      await expect(zipPage.locator('.document')).toHaveCSS(
        'background-color',
        'rgb(20, 23, 21)',
      );
      await zipPage.close();
    } finally {
      await rm(offlineFolder, { recursive: true, force: true });
    }
    const offlineJsonDownload = my.waitForEvent('download');
    await my.getByRole('button', { name: 'JSON' }).click();
    const offlineJson = await offlineJsonDownload;
    const jsonData = await readFile((await offlineJson.path())!, 'utf8');
    expect(jsonData).not.toContain('whatslink.info/screenshot');
    expect(jsonData).not.toMatch(
      /blob:|chrome-extension:\/\/|localhost|127\.0\.0\.1/,
    );
    const jsonPackage = JSON.parse(jsonData);
    expect(jsonPackage.schemaVersion).toBe(1);
    expect(jsonPackage.items[0].assets).toEqual([
      'assets/' + infoHash + '/0.png',
    ]);
    expect(jsonPackage.assets['assets/' + infoHash + '/0.png']).toBeTruthy();
    expect(
      await restartedWorker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: number })
            .__providerCalls,
      ),
    ).toBe(0);
    await my.getByRole('button', { name: 'Open detail' }).click();
    const favoriteImage = my.locator('.favorite-images img').first();
    await expect
      .poll(() =>
        favoriteImage.evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(1);
    await my.getByRole('button', { name: 'Collapse', exact: true }).click();
    await my.getByRole('button', { name: 'Settings' }).click();
    await my.getByLabel('Theme').selectOption('dark');
    await expect(my.locator('html')).toHaveAttribute('data-theme', 'dark');
    await my.getByLabel('Language').selectOption('zh_CN');
    await my.getByRole('button', { name: '收藏', exact: true }).click();
    const zhExportButton = my.getByRole('button', { name: '离线 HTML' });
    await zhExportButton.focus();
    await expect(zhExportButton).toBeFocused();
    const zhDownload = my.waitForEvent('download');
    await zhExportButton.press('Enter');
    const zhHtml = await zhDownload;
    const zhContent = await readFile((await zhHtml.path())!, 'utf8');
    expect(zhContent).toContain('<html lang="zh-CN">');
    expect(zhContent).toContain('Magnet Preview 收藏');
    await my.getByRole('button', { name: '缓存' }).click();
    await expect(my.getByRole('group', { name: '保留策略' })).toBeVisible();
    await my.getByLabel('最大 MiB').focus();
    await expect(my.getByLabel('最大 MiB')).toBeFocused();
    await expect(my.getByText('预览: 0')).toBeVisible();
    await context.close();
    context = await reopenExtensionProfile(profile);
    await context.route(/^https?:/, (route) => route.abort());
    const offlineMy = await context.newPage();
    await offlineMy.goto(`chrome-extension://${extensionId}/my.html`);
    await expect(
      offlineMy.getByRole('heading', { name: 'Persisted offline fixture' }),
    ).toBeVisible();
    await offlineMy.getByRole('button', { name: '查看详情' }).click();
    await expect
      .poll(() =>
        offlineMy
          .locator('.favorite-images img')
          .first()
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(1);
    await offlineMy.getByRole('button', { name: '取消收藏' }).click();
    await expect(offlineMy.getByText('已从收藏移除。')).toBeVisible();
    await expect(
      offlineMy.getByRole('heading', { name: 'Persisted offline fixture' }),
    ).toHaveCount(0);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('saves an early preview as an owned offline favorite without a second provider request', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  let reopened: import('@playwright/test').BrowserContext | undefined;
  await context.route(/^https?:/, (route) => route.abort());
  try {
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    const infoHash = 'C'.repeat(40);
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __releaseScreenshot?: () => void;
        __providerCalls?: number;
        __screenshotCalls?: number;
      };
      root.__providerCalls = 0;
      root.__screenshotCalls = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      root.__releaseScreenshot = release;
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === 'https://whatslink.info/screenshot/early.png') {
          root.__screenshotCalls = (root.__screenshotCalls ?? 0) + 1;
          await gate;
          const bytes = Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2cAAAAASUVORK5CYII=',
            ),
            (character) => character.charCodeAt(0),
          );
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        if (url.startsWith('https://whatslink.info/api/v1/link?')) {
          root.__providerCalls = (root.__providerCalls ?? 0) + 1;
          return new Response(
            JSON.stringify({
              error: '',
              name: 'Early saved fixture',
              size: 1024,
              count: 1,
              screenshots: [
                {
                  screenshot: 'https://whatslink.info/screenshot/early.png',
                  time: 0,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return nativeFetch(input, init);
      };
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installPopupScanResponse(popup, {
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash,
            originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
            canonicalMagnet: 'magnet:?xt=urn%3Abtih%3A' + infoHash,
          },
          occurrenceCount: 1,
        },
      ],
    });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Early saved fixture' }),
    ).toBeVisible();
    await popup.getByRole('button', { name: 'Open detail' }).click();
    await popup.getByRole('button', { name: 'Save' }).click();
    await expect(popup.getByText('Saving Favorite…')).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: number })
            .__providerCalls,
      ),
    ).toBe(1);
    await worker.evaluate(() =>
      (
        globalThis as typeof globalThis & { __releaseScreenshot?: () => void }
      ).__releaseScreenshot?.(),
    );
    await expect(popup.getByText('Saved to Favorites.')).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __screenshotCalls?: number })
            .__screenshotCalls,
      ),
    ).toBe(1);
    const favoritePageRequests: string[] = [];
    context.on('request', (request) => {
      if (request.url().startsWith('https://'))
        favoritePageRequests.push(request.url());
    });
    const my = await context.newPage();
    await my.goto(`chrome-extension://${extensionId}/my.html`);
    await expect(
      my.getByRole('heading', { name: 'Early saved fixture' }),
    ).toBeVisible();
    await my.getByRole('button', { name: 'Cache' }).click();
    await my.getByRole('button', { name: 'Clear preview cache' }).click();
    await my.getByRole('button', { name: 'Delete cache' }).click();
    await my.getByRole('button', { name: 'Favorites' }).click();
    await my.getByRole('button', { name: 'Open detail' }).click();
    await expect
      .poll(() =>
        my
          .getByRole('img', { name: /^Resource screenshot(?: \d+)?$/ })
          .last()
          .evaluate((image: HTMLImageElement) => ({
            width: image.naturalWidth,
            local: image.currentSrc.startsWith('blob:chrome-extension://'),
          })),
      )
      .toEqual({ width: 1, local: true });
    expect(favoritePageRequests).toEqual([]);
    await context.close();

    reopened = await reopenExtensionProfile(profile);
    await reopened.route(/^https?:/, (route) => route.abort());
    const offlineRequests: string[] = [];
    reopened.on('request', (request) => {
      if (request.url().startsWith('https://'))
        offlineRequests.push(request.url());
    });
    const offlineMy = await reopened.newPage();
    await offlineMy.goto(`chrome-extension://${extensionId}/my.html`);
    await expect(
      offlineMy.getByRole('heading', { name: 'Early saved fixture' }),
    ).toBeVisible();
    await offlineMy.getByRole('button', { name: 'Open detail' }).click();
    await expect
      .poll(() =>
        offlineMy
          .getByRole('img', { name: /^Resource screenshot(?: \d+)?$/ })
          .last()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await offlineMy.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (value: string) => {
            (window as Window & { __copied?: string }).__copied = value;
            return Promise.resolve();
          },
        },
      });
    });
    await offlineMy.getByRole('button', { name: 'Copy Magnet' }).click();
    await expect(offlineMy.getByText('Magnet copied.')).toBeVisible();
    expect(
      await offlineMy.evaluate(
        () => (window as Window & { __copied?: string }).__copied,
      ),
    ).toContain(infoHash);
    await offlineMy.getByRole('button', { name: 'Remove saved' }).click();
    await expect(
      offlineMy.getByText('Saved resources will appear here.'),
    ).toBeVisible();
    expect(offlineRequests).toEqual([]);
  } finally {
    await reopened?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

test('saves and removes a local-only Magnet without provider traffic', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  const external: string[] = [];
  context.on('request', (request) => {
    if (request.url().startsWith('https://')) external.push(request.url());
  });
  await context.route(/^https?:/, (route) => route.abort());
  try {
    const worker = await extensionWorker(context, diagnostics);
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    );
    const infoHash = 'B'.repeat(40);
    await installPopupScanResponse(popup, {
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash,
            originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
            canonicalMagnet:
              'magnet:?xt=urn%3Abtih%3A' + infoHash + '&dn=Local+bookmark',
          },
          occurrenceCount: 1,
        },
      ],
    });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Keep local only' }).click();
    await popup.locator('.resource-card').hover();
    await popup.getByRole('button', { name: 'Save' }).click();
    await expect(popup.getByText('Saved to Favorites.')).toBeVisible();
    await popup.mouse.move(0, 0);
    await popup.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await expect(
      popup.getByRole('button', { name: 'Remove saved' }),
    ).toBeVisible();
    const myPagePromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open My page' }).click();
    const my = await myPagePromise;
    await expect(
      my.getByRole('heading', { name: 'Local bookmark' }),
    ).toBeVisible();
    const htmlDownload = my.waitForEvent('download');
    await my.getByRole('button', { name: 'Offline HTML' }).click();
    const htmlFile = await htmlDownload;
    expect(htmlFile.suggestedFilename()).toBe('magnet-preview-favorites.html');
    expect(await readFile((await htmlFile.path())!, 'utf8')).toContain(
      'Local bookmark',
    );
    const offlineFolder = await mkdtemp(resolve(tmpdir(), 'magnet-export-'));
    try {
      const standalonePath = resolve(offlineFolder, 'favorites.html');
      await copyFile((await htmlFile.path())!, standalonePath);
      const offlineHtmlPage = await context.newPage();
      await offlineHtmlPage.goto(pathToFileURL(standalonePath).href);
      await expect(
        offlineHtmlPage.getByRole('heading', { name: 'Local bookmark' }),
      ).toBeVisible();
      await expect(offlineHtmlPage.locator('article .details')).toBeHidden();
      await offlineHtmlPage.getByRole('button', { name: 'Expand all' }).click();
      await expect(offlineHtmlPage.locator('article .details')).toBeVisible();
      await offlineHtmlPage
        .getByRole('searchbox', { name: 'Search titles' })
        .fill('missing');
      await expect(offlineHtmlPage.locator('article')).toBeHidden();
      await offlineHtmlPage
        .getByRole('searchbox', { name: 'Search titles' })
        .fill('Local');
      await expect(offlineHtmlPage.locator('article')).toBeVisible();
      await offlineHtmlPage
        .getByRole('button', { name: 'Copy Magnet' })
        .click();
      await expect(offlineHtmlPage.getByRole('status')).toHaveText(
        'Magnet copied',
      );
      await offlineHtmlPage.close();
    } finally {
      await rm(offlineFolder, { recursive: true, force: true });
    }
    const zipDownload = my.waitForEvent('download');
    await my.getByRole('button', { name: 'Full ZIP' }).click();
    const zipFile = await zipDownload;
    const zipEntries = unzipSync(
      new Uint8Array(await readFile((await zipFile.path())!)),
    );
    expect(
      JSON.parse(strFromU8(zipEntries['collection/data.json']!)).items[0]
        .infoHash,
    ).toBe(infoHash);
    const zipFolder = await mkdtemp(resolve(tmpdir(), 'magnet-zip-'));
    try {
      for (const [entry, bytes] of Object.entries(zipEntries)) {
        const target = resolve(zipFolder, entry);
        expect(target.startsWith(zipFolder + sep)).toBe(true);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, bytes);
      }
      const offlineZipPage = await context.newPage();
      await offlineZipPage.goto(
        pathToFileURL(resolve(zipFolder, 'collection/index.html')).href,
      );
      await expect(
        offlineZipPage.getByRole('heading', { name: 'Local bookmark' }),
      ).toBeVisible();
      await offlineZipPage.close();
    } finally {
      await rm(zipFolder, { recursive: true, force: true });
    }
    const jsonDownload = my.waitForEvent('download');
    await my.getByRole('button', { name: 'JSON' }).click();
    const jsonFile = await jsonDownload;
    expect(
      JSON.parse(await readFile((await jsonFile.path())!, 'utf8'))
        .schemaVersion,
    ).toBe(1);
    await my.getByRole('button', { name: 'Open detail' }).click();
    await expect(my.getByText(infoHash, { exact: true })).toBeVisible();
    await my.getByRole('button', { name: 'Remove saved' }).click();
    await expect(
      my.getByText('Saved resources will appear here.'),
    ).toBeVisible();
    await popup.locator('.resource-card').hover();
    await expect(popup.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(external).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('keeps long local Favorites synchronized and keyboard-accessible across Popup and My', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  const external: string[] = [];
  context.on('request', (request) => {
    if (request.url().startsWith('https://')) external.push(request.url());
  });
  await context.route(/^https?:/, (route) => route.abort());
  try {
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    const infoHash = 'D'.repeat(40);
    const longName = '长标题 Long resource title '.repeat(18);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installPopupScanResponse(popup, {
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash,
            originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
            canonicalMagnet:
              'magnet:?xt=urn%3Abtih%3A' +
              infoHash +
              '&dn=' +
              encodeURIComponent(longName),
            displayName: longName,
          },
          occurrenceCount: 1,
        },
      ],
    });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Keep local only' }).click();
    await popup.getByRole('button', { name: 'Open detail' }).click();
    const save = popup.getByRole('button', { name: 'Save' });
    await save.focus();
    await save.press('Space');
    await expect(popup.getByText('Saved to Favorites.')).toBeVisible();
    await popup.getByRole('button', { name: 'Back' }).click();
    await expect(
      popup.locator('.resource-card-actions button[aria-pressed]'),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      await popup.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const my = await context.newPage();
    await my.goto(`chrome-extension://${extensionId}/my.html`);
    await expect(my.getByRole('heading', { name: longName })).toBeVisible();
    await my.getByRole('button', { name: 'Settings' }).click();
    await my.getByLabel('Theme').selectOption('dark');
    await my.getByLabel('Language').selectOption('zh_CN');
    await my.getByRole('button', { name: '收藏', exact: true }).click();
    await expect(my.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(
      await my.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const open = my.getByRole('button', { name: '查看详情' });
    await open.focus();
    await open.press('Enter');
    await expect(my.getByText(infoHash, { exact: true })).toBeVisible();
    await my.getByRole('button', { name: '折叠', exact: true }).click();
    await expect(my.getByRole('button', { name: '查看详情' })).toBeFocused();
    await my.getByRole('button', { name: '取消收藏' }).click();
    await expect(
      popup.locator('.resource-card-actions button[aria-pressed]'),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(external).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('reports a partial Favorite when an approved screenshot is unavailable', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  await context.route(/^https?:/, (route) => route.abort());
  try {
    const worker = await extensionWorker(context, diagnostics);
    const extensionId = new URL(worker.url()).host;
    const infoHash = 'E'.repeat(40);
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __providerCalls?: number;
      };
      root.__providerCalls = 0;
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === 'https://whatslink.info/screenshot/missing.svg')
          return new Response('<svg/>', {
            status: 200,
            headers: { 'content-type': 'image/svg+xml' },
          });
        if (url.startsWith('https://whatslink.info/api/v1/link?')) {
          root.__providerCalls = (root.__providerCalls ?? 0) + 1;
          return new Response(
            JSON.stringify({
              error: '',
              name: 'Partial image fixture',
              size: 1024,
              count: 1,
              screenshots: [
                {
                  screenshot: 'https://whatslink.info/screenshot/missing.svg',
                  time: 0,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return nativeFetch(input, init);
      };
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installPopupScanResponse(popup, {
      kind: 'success',
      magnets: [
        {
          magnet: {
            infoHash,
            originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
            canonicalMagnet: 'magnet:?xt=urn%3Abtih%3A' + infoHash,
          },
          occurrenceCount: 1,
        },
      ],
    });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await expect(
      popup.getByRole('heading', { name: 'Partial image fixture' }),
    ).toBeVisible();
    await popup.getByRole('button', { name: 'Save' }).click();
    await expect(
      popup.getByText(
        'Saved to Favorites. Some images are unavailable offline.',
      ),
    ).toBeVisible();
    const external: string[] = [];
    context.on('request', (request) => {
      if (request.url().startsWith('https://')) external.push(request.url());
    });
    const my = await context.newPage();
    await my.goto(`chrome-extension://${extensionId}/my.html`);
    await my.getByRole('button', { name: 'Open detail' }).click();
    await expect(
      my.getByText('Local preview image is unavailable.'),
    ).toBeVisible();
    await expect(
      my.getByText('Some images could not be saved for offline use.'),
    ).toBeVisible();
    expect(external).toEqual([]);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: number })
            .__providerCalls,
      ),
    ).toBe(1);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('keeps twenty returned previews contained and loads an anonymous same-origin screenshot from a local route', async () => {
  const { context, profile, diagnostics } = await launchExtension();
  const routed: string[] = [];
  await context.route(/^https?:/, (route) => {
    const url = route.request().url();
    routed.push(url);
    if (url === 'https://whatslink.info/screenshot/test.svg') {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
      });
    }
    return route.abort();
  });
  try {
    const worker = await extensionWorker(context, diagnostics);
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __providerCalls?: string[];
      };
      root.__providerCalls = [];
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith('https://whatslink.info/api/v1/link?'))
          return nativeFetch(input, init);
        const hash =
          new URL(url).searchParams.get('url')?.split('urn:btih:')[1] ?? '';
        root.__providerCalls?.push(hash);
        return new Response(
          JSON.stringify({
            error: '',
            name: 'Long returned resource '.repeat(18) + hash.slice(-2),
            size: 1024,
            count: 1,
            screenshots: hash.endsWith('0')
              ? [
                  {
                    screenshot: 'https://whatslink.info/screenshot/test.svg',
                    time: 0,
                  },
                ]
              : [],
          }),
          { status: 200 },
        );
      };
    });
    const popup = await context.newPage();
    const errors: string[] = [];
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(
      'chrome-extension://' + new URL(worker.url()).host + '/popup.html',
    );
    const magnets = Array.from({ length: 20 }, (_, n) => {
      const infoHash = n.toString(16).padStart(40, '0').toUpperCase();
      return {
        magnet: {
          infoHash,
          originalMagnet: 'magnet:?xt=urn:btih:' + infoHash,
          canonicalMagnet: 'magnet:?xt=urn%3Abtih%3A' + infoHash,
        },
        occurrenceCount: 1,
      };
    });
    await installPopupScanResponse(popup, { kind: 'success', magnets });
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await expect
      .poll(
        () =>
          worker.evaluate(
            () =>
              (globalThis as typeof globalThis & { __providerCalls?: string[] })
                .__providerCalls?.length,
          ),
        { timeout: 15_000 },
      )
      .toBe(20);
    await expect(popup.getByRole('article')).toHaveCount(20);
    const list = await popup.evaluate(() => {
      const root = document.querySelector('.popup-shell') as HTMLElement;
      const content = document.querySelector('.popup-content') as HTMLElement;
      return {
        overflow: root.scrollWidth > root.clientWidth,
        scrollable: content.scrollHeight > content.clientHeight,
      };
    });
    expect(list).toEqual({ overflow: false, scrollable: true });
    const scrolledDetail = popup
      .getByRole('button', { name: 'Open detail' })
      .nth(16);
    await scrolledDetail.scrollIntoViewIfNeeded();
    const resultsScrollTop = await popup
      .locator('.popup-content')
      .evaluate((node) => node.scrollTop);
    expect(resultsScrollTop).toBeGreaterThan(0);
    await scrolledDetail.click();
    await expect(
      popup.getByRole('button', { name: 'Back', exact: true }),
    ).toBeFocused();
    await expect
      .poll(() =>
        popup.locator('.popup-content').evaluate((node) => node.scrollTop),
      )
      .toBe(0);
    const image = popup
      .getByRole('img', { name: /^Resource screenshot(?: \d+)?$/ })
      .first();
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBe(8);
    const detailOverflow = await popup.evaluate(() => {
      const root = document.querySelector('.popup-shell') as HTMLElement;
      return root.scrollWidth > root.clientWidth;
    });
    expect(detailOverflow).toBe(false);
    await popup.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(scrolledDetail).toBeFocused();
    await expect
      .poll(() =>
        popup.locator('.popup-content').evaluate((node) => node.scrollTop),
      )
      .toBe(resultsScrollTop);
    expect(
      routed.every(
        (url) => url === 'https://whatslink.info/screenshot/test.svg',
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('scans the hostile fixture through the unpacked extension without provider traffic or DOM mutation', async () => {
  const fixture = await hostileFixture();
  const { context, profile, diagnostics } = await launchExtension();
  const providerHosts =
    /(^|\.)(whatslink\.info|webtor\.io|torbox\.app|seedr\.cc)$/i;
  const providerRequests: string[] = [];
  const externalRequests: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (providerHosts.test(url.hostname)) providerRequests.push(request.url());
    if (
      url.origin !== fixture.url.replace('/hostile.html', '') &&
      url.protocol !== 'chrome-extension:'
    )
      externalRequests.push(request.url());
  });
  try {
    const worker = await extensionWorker(context, diagnostics);
    const page = await context.newPage();
    await page.addInitScript(() =>
      Object.defineProperty(window, 'chrome', {
        value: { runtime: { onMessage: { addListener: () => undefined } } },
      }),
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixture.url);
    await page.waitForTimeout(30);
    const before = await page.locator('body').innerHTML();
    await expect(worker.url()).toContain('chrome-extension://');
    await page.addScriptTag({ path: resolve(extensionPath, 'scanner.js') });
    const result = (await page.evaluate(() =>
      (
        window as typeof window & { __magnetPreviewScan: () => unknown }
      ).__magnetPreviewScan(),
    )) as {
      truncated: boolean;
      magnets: Array<{
        magnet: { infoHash: string; displayName?: string };
        occurrences: unknown[];
      }>;
    };
    expect(result).toMatchObject({ truncated: false });
    expect(result.magnets).toHaveLength(3);
    expect(
      result.magnets.map(
        (item: { magnet: { infoHash: string } }) => item.magnet.infoHash,
      ),
    ).toEqual([
      '0123456789ABCDEF0123456789ABCDEF01234567',
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
    ]);
    expect(result.magnets[0]).toMatchObject({
      occurrences: [{}, {}],
      magnet: { displayName: '电影 🎬' },
    });
    expect(await page.locator('body').innerHTML()).toBe(before);
    await page.goto(`${fixture.url}?case=long-list`);
    await page.waitForTimeout(30);
    const longListBefore = await page.locator('body').innerHTML();
    await page.addScriptTag({ path: resolve(extensionPath, 'scanner.js') });
    const longListResult = (await page.evaluate(() =>
      (
        window as typeof window & { __magnetPreviewScan: () => unknown }
      ).__magnetPreviewScan(),
    )) as {
      truncated: boolean;
      magnets: Array<{ magnet: { displayName?: string } }>;
    };
    expect(longListResult.truncated).toBe(false);
    expect(longListResult.magnets).toHaveLength(20);
    expect(
      longListResult.magnets.some((item) =>
        item.magnet.displayName?.includes('长资源名称 19'),
      ),
    ).toBe(true);
    expect(await page.locator('body').innerHTML()).toBe(longListBefore);
    await page.goto(`${fixture.url}?case=legal-sintel`);
    await page.addScriptTag({ path: resolve(extensionPath, 'scanner.js') });
    const legalResult = (await page.evaluate(() =>
      (
        window as typeof window & { __magnetPreviewScan: () => unknown }
      ).__magnetPreviewScan(),
    )) as { magnets: Array<{ magnet: { infoHash: string } }> };
    expect(legalResult.magnets.map((item) => item.magnet.infoHash)).toEqual([
      '08ADA5A7A6183AAE1E09D831DF6748D566095A10',
    ]);
    expect(errors).toEqual([]);
    expect(providerRequests).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    await context.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
  }
});
