import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { listenFixture } from './fixtureServer';

const hash = '0123456789ABCDEF0123456789ABCDEF01234567';
const evidence = resolve('docs/evidence/0009');

test('Hover waits for intent, uses background cache, and revokes on disable', async () => {
  const html = await readFile(
    resolve('tests/e2e/fixtures/hostile-page.html'),
    'utf8',
  );
  const server = createServer((_request, response) => response.end(html));
  const address = await listenFixture(server);
  const fixtureUrl = `http://127.0.0.1:${address.port}/hostile.html`;
  const temp = await mkdtemp(resolve(tmpdir(), 'magnet-hover-bridge-'));
  const extension = resolve(temp, 'extension');
  const profile = resolve(temp, 'profile');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
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
  const errors: string[] = [];
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixtureUrl);
    const tabId = await worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      fixtureUrl,
    );
    expect(tabId).toBeTruthy();
    const thumbnail = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#dbe7df';
      drawing.fillRect(0, 0, 160, 120);
      drawing.fillStyle = '#648871';
      drawing.fillRect(24, 32, 112, 64);
      return canvas.toDataURL('image/png');
    });
    await worker.evaluate(
      ({ tabId, fixtureUrl, thumbnail }) => {
        const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
          query.active
            ? [{ id: tabId, url: fixtureUrl }]
            : nativeQuery(query)) as typeof chrome.tabs.query;
        const root = globalThis as typeof globalThis & {
          __hoverCalls?: string[];
        };
        root.__hoverCalls = [];
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (url === 'https://whatslink.info/screenshot/hover-fixture.png') {
            const bytes = Uint8Array.from(
              atob(thumbnail.split(',')[1]!),
              (char) => char.charCodeAt(0),
            );
            return new Response(bytes, {
              status: 200,
              headers: { 'content-type': 'image/png' },
            });
          }
          if (!url.startsWith('https://whatslink.info/api/v1/link?'))
            return nativeFetch(input, init);
          const hash =
            new URL(url).searchParams.get('url')?.split('urn:btih:')[1] ?? '';
          root.__hoverCalls!.push(hash);
          return new Response(
            JSON.stringify({
              error: '',
              name: `Fixture ${hash.slice(0, 6)}`,
              size: 1024,
              count: 2,
              screenshots: [
                {
                  screenshot:
                    'https://whatslink.info/screenshot/hover-fixture.png',
                  time: 0,
                },
              ],
            }),
            { status: 200 },
          );
        };
      },
      { tabId, fixtureUrl, thumbnail },
    );
    const my = await context.newPage();
    my.on('pageerror', (error) => errors.push(error.message));
    await my.goto(`chrome-extension://${extensionId}/my.html`);
    await my.getByRole('button', { name: 'Settings' }).click();
    await my.getByLabel('Online previews via WhatsLink').check();
    await my.getByLabel('Hover preview').check();
    const popup = await context.newPage();
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const nativeQuery = await popup.evaluate((tabId) => {
      const previous = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
        query.active
          ? [{ id: tabId }]
          : previous(query)) as typeof chrome.tabs.query;
      return true;
    }, tabId);
    expect(nativeQuery).toBe(true);
    await popup.locator('.popup-page-options summary').click();
    await popup
      .getByRole('button', { name: 'Activate hover on this page' })
      .click();
    await expect(
      popup.getByRole('button', { name: 'Disable hover on this page' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      popup.getByText('Hover preview is active on this page.'),
    ).toHaveCount(0);
    await mkdir(resolve('docs/evidence/0015'), { recursive: true });
    await popup.screenshot({
      path: resolve('docs/evidence/0015/popup-hover-on.png'),
    });
    await popup.addInitScript(
      ({ tabId, fixtureUrl }) => {
        const native = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
          query.active
            ? [{ id: tabId, url: fixtureUrl }]
            : native(query)) as typeof chrome.tabs.query;
      },
      { tabId, fixtureUrl },
    );
    await popup.reload();
    await popup.locator('.popup-page-options summary').click();
    await expect(
      popup.getByRole('button', { name: 'Disable hover on this page' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await popup
      .getByRole('button', { name: 'Disable hover on this page' })
      .click();
    await expect(
      popup.getByRole('button', { name: 'Activate hover on this page' }),
    ).toHaveAttribute('aria-pressed', 'false');
    await popup.screenshot({
      path: resolve('docs/evidence/0015/popup-hover-off.png'),
    });
    await popup
      .getByRole('button', { name: 'Activate hover on this page' })
      .click();
    await expect(
      popup.getByRole('button', { name: 'Disable hover on this page' }),
    ).toHaveAttribute('aria-pressed', 'true');
    const hosts = page.locator('magnet-preview-hover');
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await page.waitForTimeout(200);
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerleave')));
    await page.waitForTimeout(500);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __hoverCalls?: string[] })
            .__hoverCalls,
      ),
    ).toEqual([]);
    await expect(hosts).toHaveCount(0);
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await expect(hosts).toHaveCount(1);
    await expect
      .poll(() =>
        hosts.evaluate(
          (node) => node.shadowRoot?.querySelector('.title')?.textContent,
        ),
      )
      .toBe(`Fixture ${hash.slice(0, 6)}`);
    const box = await hosts.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(900);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    await mkdir(evidence, { recursive: true });
    await expect
      .poll(() =>
        hosts
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(160);
    const media = hosts.locator('.media');
    const mediaBox = (await media.boundingBox())!;
    const titleBox = (await hosts.locator('.title').boundingBox())!;
    expect(titleBox.x).toBeGreaterThan(mediaBox.x + mediaBox.width);
    await page.screenshot({ path: resolve(evidence, 'hover-light.png') });
    await mkdir(resolve('docs/evidence/0014'), { recursive: true });
    await hosts.screenshot({
      path: resolve('docs/evidence/0014/refined-hover-thumbnail-light.png'),
    });
    await hosts.locator('img').dispatchEvent('error');
    await expect(hosts.locator('img')).toHaveCount(0);
    expect(await media.boundingBox()).toEqual(mediaBox);
    expect(await hosts.locator('.title').boundingBox()).toEqual(titleBox);
    await hosts.screenshot({
      path: resolve('docs/evidence/0014/refined-hover-thumbnail-missing.png'),
    });
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerleave')));
    await expect(hosts).toHaveCount(0);
    await page
      .locator('#hostile > a')
      .nth(2)
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await expect(hosts).toHaveCount(1);
    await expect
      .poll(() =>
        hosts.evaluate(
          (node) => node.shadowRoot?.querySelector('.title')?.textContent,
        ),
      )
      .toBe(`Fixture ${hash.slice(0, 6)}`);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __hoverCalls?: string[] })
            .__hoverCalls,
      ),
    ).toEqual([hash]);
    await popup.getByRole('button', { name: 'Scan current page' }).click();
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (globalThis as typeof globalThis & { __hoverCalls?: string[] })
              .__hoverCalls?.length,
        ),
      )
      .toBe(3);
    const calls = await worker.evaluate(
      () =>
        (globalThis as typeof globalThis & { __hoverCalls?: string[] })
          .__hoverCalls,
    );
    expect(calls?.filter((value) => value === hash)).toHaveLength(1);
    await popup
      .getByRole('button', { name: 'Open page preview controls' })
      .click();
    const pageTools = page.locator('magnet-preview-tools');
    await expect(pageTools).toHaveCount(1);
    await pageTools
      .getByRole('button', { name: 'Show inline previews' })
      .click();
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(3);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __hoverCalls?: string[] })
            .__hoverCalls?.length,
      ),
    ).toBe(3);
    await my.getByLabel('Hover preview').uncheck();
    await expect(
      popup.getByRole('button', { name: 'Activate hover on this page' }),
    ).toHaveCount(0);
    await expect(hosts).toHaveCount(0);
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await page.waitForTimeout(700);
    await expect(hosts).toHaveCount(0);
    await my.getByLabel('Hover preview').check();
    await popup.locator('.popup-page-options summary').click();
    await expect(
      popup.getByRole('button', { name: 'Activate hover on this page' }),
    ).toBeVisible();
    await popup
      .getByRole('button', { name: 'Activate hover on this page' })
      .click();
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await page.waitForTimeout(700);
    await expect(hosts).toHaveCount(0);
    await pageTools
      .getByRole('button', { name: 'Remove inline previews' })
      .click();
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await expect(hosts).toHaveCount(1);
    await my.getByLabel('Online previews via WhatsLink').uncheck();
    await expect(hosts).toHaveCount(0);
    await expect(pageTools).toHaveCount(0);
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(0);
    await my.getByLabel('Theme').selectOption('dark');
    await my.getByLabel('Language').selectOption('zh_CN');
    await popup.getByRole('button', { name: '在当前页面启用悬停预览' }).click();
    await expect(
      popup.getByRole('button', { name: '在当前页面关闭悬停预览' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.getByText('当前页面已启用悬停预览。')).toHaveCount(0);
    await page.setViewportSize({ width: 450, height: 350 });
    await page.evaluate(async () => {
      document.documentElement.style.zoom = '2';
      // Let resize and hit testing settle before simulating pointer entry.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await page
      .locator('#hostile > a')
      .first()
      .evaluate((node) => node.dispatchEvent(new Event('pointerenter')));
    await expect(hosts).toHaveCount(1);
    await expect
      .poll(() =>
        hosts.evaluate((node) =>
          node.shadowRoot?.textContent?.includes('仅本地'),
        ),
      )
      .toBe(true);
    expect(await hosts.getAttribute('data-theme')).toBe('dark');
    const zoomBox = await hosts.boundingBox();
    expect(zoomBox).not.toBeNull();
    expect(zoomBox!.x).toBeGreaterThanOrEqual(0);
    expect(zoomBox!.x + zoomBox!.width).toBeLessThanOrEqual(450);
    expect(zoomBox!.y).toBeGreaterThanOrEqual(0);
    expect(zoomBox!.y + zoomBox!.height).toBeLessThanOrEqual(350);
    await page.screenshot({ path: resolve(evidence, 'hover-dark-zoom.png') });
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { __hoverCalls?: string[] })
            .__hoverCalls?.length,
      ),
    ).toBe(3);
    await page.reload();
    await popup.reload();
    await popup.locator('.popup-page-options summary').click();
    await expect(
      popup.getByRole('button', { name: '在当前页面启用悬停预览' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(temp, { recursive: true, force: true });
  }
});
