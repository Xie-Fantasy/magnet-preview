import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { listenFixture } from './fixtureServer';

const built = resolve('.output/chrome-mv3');
const firstHash = '0123456789ABCDEF0123456789ABCDEF01234567';
const textHash = '2'.repeat(40);

test('Popup and Inline share the real background manager and cache through a fixture-only grant', async () => {
  const fixtureHtml = await readFile(
    resolve('tests/e2e/fixtures/hostile-page.html'),
    'utf8',
  );
  const server = createServer((_request, response) =>
    response.end(fixtureHtml),
  );
  const address = await listenFixture(server);
  const fixtureUrl = `http://127.0.0.1:${address.port}/hostile.html`;
  const temp = await mkdtemp(resolve(tmpdir(), 'magnet-inline-bridge-'));
  const extension = resolve(temp, 'extension');
  const profile = resolve(temp, 'profile');
  await cp(built, extension, { recursive: true });
  const manifestPath = resolve(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const external: string[] = [];
  const pageExternal: string[] = [];
  const errors: string[] = [];
  context.on('request', (request) => {
    if (request.url().startsWith('https://')) external.push(request.url());
  });
  await context.route(/^https?:/, (route) =>
    route.request().url().startsWith('http://127.0.0.1:')
      ? route.continue()
      : route.abort(),
  );
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    page.on('request', (request) => {
      if (request.url().startsWith('https://'))
        pageExternal.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixtureUrl);
    const tabId = await worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      fixtureUrl,
    );
    expect(tabId).toBeTruthy();
    await worker.evaluate(
      ({ targetTabId, fixtureUrl }) => {
        const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
          query.active
            ? [{ id: targetTabId, url: fixtureUrl }]
            : nativeQuery(query)) as typeof chrome.tabs.query;
      },
      { targetTabId: tabId, fixtureUrl },
    );
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __providerCalls?: string[];
        __imageCalls?: number;
      };
      root.__providerCalls = [];
      root.__imageCalls = 0;
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === 'https://whatslink.info/screenshot/fixture.png') {
          root.__imageCalls!++;
          const data = atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
          );
          return new Response(
            Uint8Array.from(data, (char) => char.charCodeAt(0)),
            { status: 200, headers: { 'content-type': 'image/png' } },
          );
        }
        if (!url.startsWith('https://whatslink.info/api/v1/link?'))
          return nativeFetch(input, init);
        const hash =
          new URL(url).searchParams.get('url')?.split('urn:btih:')[1] ?? '';
        root.__providerCalls!.push(hash);
        return new Response(
          JSON.stringify({
            error: '',
            name: `Fixture ${hash.slice(0, 6)}`,
            size: 1024,
            count: 2,
            screenshots:
              hash === '0123456789ABCDEF0123456789ABCDEF01234567'
                ? [
                    {
                      screenshot:
                        'https://whatslink.info/screenshot/fixture.png',
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
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(
      ({ tabId, hash }) => {
        const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
          query.active
            ? [{ id: tabId }]
            : nativeQuery(query)) as typeof chrome.tabs.query;
        const nativeSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = ((message: unknown) =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: string }).type === 'scan-active-tab'
            ? Promise.resolve({
                kind: 'success',
                magnets: [
                  {
                    magnet: {
                      infoHash: hash,
                      canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${hash}`,
                      originalMagnet: `magnet:?xt=urn:btih:${hash}`,
                    },
                    occurrenceCount: 2,
                  },
                ],
              })
            : nativeSend(message)) as typeof chrome.runtime.sendMessage;
      },
      { tabId, hash: firstHash },
    );
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await popup
      .getByRole('button', { name: 'Open page preview controls' })
      .click();
    const pageTools = page.locator('magnet-preview-tools');
    await expect(pageTools).toHaveCount(1);
    await page.setViewportSize({ width: 320, height: 320 });
    const compactBox = await pageTools.boundingBox();
    expect(compactBox).not.toBeNull();
    expect(compactBox!.x).toBeGreaterThanOrEqual(0);
    expect(compactBox!.x + compactBox!.width).toBeLessThanOrEqual(320);
    await page.setViewportSize({ width: 1280, height: 720 });
    const showInline = pageTools.getByRole('button', {
      name: 'Show inline previews',
    });
    await showInline.focus();
    await showInline.press('Enter');
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(3);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls?.length,
      ),
    ).toBe(0);
    await pageTools
      .getByRole('button', { name: 'Remove inline previews' })
      .click();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    await popup.getByRole('button', { name: 'Enable previews' }).click();
    await expect(
      popup.getByRole('heading', { name: `Fixture ${firstHash.slice(0, 6)}` }),
    ).toBeVisible();
    await popup
      .getByRole('button', { name: 'Open page preview controls' })
      .click();
    await pageTools
      .getByRole('button', { name: 'Show inline previews' })
      .click();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(3);
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (globalThis as typeof globalThis & { __providerCalls?: string[] })
              .__providerCalls?.length,
        ),
      )
      .toBe(2);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls,
      ),
    ).toEqual([firstHash, textHash]);
    const duplicate = page.locator(
      `[data-magnet-preview-inline="${firstHash}"]`,
    );
    await expect(duplicate).toHaveCount(2);
    await expect
      .poll(() =>
        duplicate
          .first()
          .evaluate(
            (host) => host.shadowRoot?.querySelector('.title')?.textContent,
          ),
      )
      .toBe(`Fixture ${firstHash.slice(0, 6)}`);
    await expect
      .poll(() =>
        duplicate
          .first()
          .evaluate((host) =>
            host.shadowRoot
              ?.querySelector('img')
              ?.getAttribute('src')
              ?.startsWith('data:image/png;base64,'),
          ),
      )
      .toBe(true);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __imageCalls?: number })
            .__imageCalls,
      ),
    ).toBe(1);
    await mkdir(resolve('docs/evidence/0008'), { recursive: true });
    const media = duplicate.first().locator('.media');
    const mediaBounds = await media.boundingBox();
    const titleBounds = await duplicate.first().locator('.title').boundingBox();
    await mkdir(resolve('docs/evidence/0014'), { recursive: true });
    await duplicate.first().screenshot({
      path: resolve('docs/evidence/0014/refined-inline-thumbnail-light.png'),
    });
    await duplicate.first().locator('img').dispatchEvent('error');
    await expect(duplicate.first().locator('img')).toHaveCount(0);
    expect(await media.boundingBox()).toEqual(mediaBounds);
    expect(await duplicate.first().locator('.title').boundingBox()).toEqual(
      titleBounds,
    );
    await duplicate.first().screenshot({
      path: resolve('docs/evidence/0014/refined-inline-thumbnail-missing.png'),
    });
    await page.screenshot({
      path: resolve('docs/evidence/0008/inline-online.png'),
      fullPage: true,
    });
    await popup
      .getByRole('button', { name: 'Open page preview controls' })
      .click();
    await expect(pageTools).toHaveCount(1);
    await expect(
      pageTools.getByRole('button', { name: 'Remove inline previews' }),
    ).toBeVisible();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(3);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls?.length,
      ),
    ).toBe(2);
    await pageTools
      .getByRole('button', { name: 'Remove inline previews' })
      .click();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    await pageTools
      .getByRole('button', { name: 'Show inline previews' })
      .click();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(3);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls?.length,
      ),
    ).toBe(2);
    await popup.evaluate((hash) => {
      const nativeSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: unknown) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'scan-active-tab'
          ? Promise.resolve({
              kind: 'success',
              magnets: [
                {
                  magnet: {
                    infoHash: hash,
                    canonicalMagnet: `magnet:?xt=urn%3Abtih%3A${hash}`,
                    originalMagnet: `magnet:?xt=urn:btih:${hash}`,
                  },
                  occurrenceCount: 1,
                },
              ],
            })
          : nativeSend(message)) as typeof chrome.runtime.sendMessage;
    }, textHash);
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await expect(
      popup.getByRole('heading', { name: `Fixture ${textHash.slice(0, 6)}` }),
    ).toBeVisible();
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __providerCalls?: string[] })
            .__providerCalls?.length,
      ),
    ).toBe(2);
    expect(
      external.every(
        (url) => url === 'https://whatslink.info/screenshot/fixture.png',
      ),
    ).toBe(true);
    expect(pageExternal).toEqual([]);
    expect(errors).toEqual([]);
    await popup.close();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(3);
    await pageTools
      .getByRole('button', { name: 'Remove inline previews' })
      .click();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    await worker.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __inlineHeld?: boolean;
        __dismissSeen?: boolean;
        __releaseInline?: () => void;
      };
      root.__inlineHeld = false;
      root.__dismissSeen = false;
      const nativeSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      let held = false;
      chrome.tabs.sendMessage = ((targetTabId: number, message: unknown) => {
        if ((message as { type?: string })?.type !== 'inline-activate' || held)
          return nativeSend(targetTabId, message);
        held = true;
        return new Promise((resolve, reject) => {
          root.__inlineHeld = true;
          root.__releaseInline = () => {
            void nativeSend(targetTabId, message).then(resolve, reject);
          };
        });
      }) as typeof chrome.tabs.sendMessage;
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'page-tools-dismiss') root.__dismissSeen = true;
      });
    });
    await pageTools
      .getByRole('button', { name: 'Show inline previews' })
      .click();
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (globalThis as typeof globalThis & { __inlineHeld?: boolean })
              .__inlineHeld,
        ),
      )
      .toBe(true);
    await pageTools.locator('button.close').click();
    await pageTools
      .getByRole('checkbox', { name: 'Hide floating button', exact: true })
      .check();
    await pageTools
      .getByRole('button', { name: 'Hide floating button', exact: true })
      .click();
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (globalThis as typeof globalThis & { __dismissSeen?: boolean })
              .__dismissSeen,
        ),
      )
      .toBe(true);
    await worker.evaluate(() => {
      (
        globalThis as typeof globalThis & { __releaseInline?: () => void }
      ).__releaseInline?.();
    });
    await expect(pageTools).toHaveCount(0);
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    expect(
      await worker.evaluate(
        async (targetTabId) =>
          (
            await chrome.storage.session.get(
              `magnetPreview.pageTools.${targetTabId}`,
            )
          )[`magnetPreview.pageTools.${targetTabId}`],
        tabId,
      ),
    ).toBeUndefined();
  } finally {
    await context.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(temp, { recursive: true, force: true });
  }
});
