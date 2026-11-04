import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const hash = '0123456789ABCDEF0123456789ABCDEF01234567';
const evidence = resolve('docs/evidence/0008');

async function fixture() {
  const html = await readFile(
    resolve('tests/e2e/fixtures/hostile-page.html'),
    'utf8',
  );
  const server = createServer((_request, response) => response.end(html));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/hostile.html`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('packaged Inline runtime is user-invoked, isolated, idempotent, removable and local-only', async () => {
  const site = await fixture();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().startsWith('https://')) external.push(request.url());
  });
  try {
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __inlineListeners?: Array<
            (
              message: unknown,
              sender: unknown,
              respond: (value: unknown) => void,
            ) => void
          >;
        }
      ).__inlineListeners = [];
      Object.defineProperty(window, 'chrome', {
        value: {
          runtime: {
            onMessage: {
              addListener: (
                listener: (
                  message: unknown,
                  sender: unknown,
                  respond: (value: unknown) => void,
                ) => void,
              ) => {
                (
                  window as typeof window & {
                    __inlineListeners: Array<typeof listener>;
                  }
                ).__inlineListeners.push(listener);
              },
            },
          },
        },
      });
    });
    await page.goto(site.url);
    await page.addScriptTag({ path: resolve('.output/chrome-mv3/inline.js') });
    const hosts = page.locator('[data-magnet-preview-inline]');
    await expect(hosts).toHaveCount(0);
    const before = await page
      .locator('#hostile > a')
      .evaluateAll((anchors) => anchors.map((a) => a.outerHTML));
    const invoke = (type: string, extra: Record<string, unknown> = {}) =>
      page.evaluate(
        ({ type, extra }) => {
          let response: unknown;
          const listeners = (
            window as typeof window & {
              __inlineListeners: Array<
                (
                  message: unknown,
                  sender: unknown,
                  respond: (value: unknown) => void,
                ) => void
              >;
            }
          ).__inlineListeners;
          for (const listener of listeners)
            listener({ type, ...extra }, {}, (value) => {
              response = value;
            });
          return response;
        },
        { type, extra },
      );
    const labels = {
      localOnly: 'Local only',
      loading: 'Loading',
      unavailable: 'Unavailable',
      identity: 'Magnet resource',
      fileCount: 'Files',
      size: 'Size',
    };
    const result = (await invoke('inline-activate', {
      presentation: { theme: 'light', labels },
      online: false,
    })) as { mounted: number; magnets: unknown[] };
    expect(result.mounted).toBe(3);
    expect(result.magnets).toHaveLength(2);
    await expect(hosts).toHaveCount(3);
    expect(
      await page
        .locator('#hostile > a')
        .evaluateAll((anchors) => anchors.map((a) => a.outerHTML)),
    ).toEqual(before);
    const first = hosts.first();
    expect(
      await first.evaluate(
        (node) =>
          getComputedStyle(node.shadowRoot!.querySelector('.card')!).fontSize,
      ),
    ).toBe('13px');
    expect(
      await first.evaluate(
        (node) =>
          getComputedStyle(node.shadowRoot!.querySelector('.card')!).color,
      ),
    ).toBe('rgb(32, 40, 36)');
    expect(
      await first.evaluate(
        (node) =>
          getComputedStyle(node.shadowRoot!.querySelector('.card')!)
            .backgroundColor,
      ),
    ).toBe('rgb(255, 255, 255)');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: resolve(evidence, 'inline-light.png'),
      fullPage: true,
    });
    await invoke('inline-activate', {
      presentation: { theme: 'light', labels },
      online: false,
    });
    await expect(hosts).toHaveCount(3);
    await page.evaluate(() => {
      const added = document.createElement('a');
      added.href = `magnet:?xt=urn:btih:${'3'.repeat(40)}`;
      added.textContent = 'dynamic Magnet';
      document.querySelector('#hostile')!.append(added);
    });
    await invoke('inline-activate', {
      presentation: { theme: 'light', labels },
      online: false,
    });
    await expect(hosts).toHaveCount(4);
    await invoke('inline-update', {
      infoHash: hash,
      state: { phase: 'success' },
      result: {
        infoHash: hash,
        magnet: `magnet:?xt=urn:btih:${hash}`,
        name: '<script>bad</script> Long title '.repeat(5),
        totalBytes: 1024,
        fileCount: 2,
        screenshots: [],
        providerId: 'fixture',
        fetchedAt: 1,
      },
    });
    const duplicateNames = await hosts.evaluateAll((nodes) =>
      nodes
        .filter(
          (node) =>
            node.getAttribute('data-magnet-preview-inline') ===
            '0123456789ABCDEF0123456789ABCDEF01234567',
        )
        .map((node) => node.shadowRoot?.querySelector('.title')?.textContent),
    );
    expect(duplicateNames).toHaveLength(2);
    expect(duplicateNames[0]).toContain('<script>bad</script>');
    expect(
      await first.evaluate((node) => node.shadowRoot?.querySelector('script')),
    ).toBeNull();
    await page.screenshot({
      path: resolve(evidence, 'inline-duplicate-long-title.png'),
      fullPage: true,
    });
    await invoke('inline-activate', {
      presentation: {
        theme: 'dark',
        labels: { ...labels, localOnly: '仅本地' },
      },
      online: false,
    });
    expect(await first.getAttribute('data-theme')).toBe('dark');
    expect(
      await first.evaluate((node) => node.shadowRoot?.textContent),
    ).toContain('仅本地');
    await page.screenshot({
      path: resolve(evidence, 'inline-dark.png'),
      fullPage: true,
    });
    await invoke('inline-remove');
    await expect(hosts).toHaveCount(0);
    expect(
      await page
        .locator('#hostile > a')
        .evaluateAll((anchors) => anchors.slice(0, 5).map((a) => a.outerHTML)),
    ).toEqual(before);
    await invoke('inline-activate', {
      presentation: { theme: 'light', labels },
      online: false,
    });
    await expect(hosts).toHaveCount(4);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('packaged Inline runtime contains a hostile long list', async () => {
  const site = await fixture();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __inlineListeners?: Array<
            (
              message: unknown,
              sender: unknown,
              respond: (value: unknown) => void,
            ) => void
          >;
        }
      ).__inlineListeners = [];
      Object.defineProperty(window, 'chrome', {
        value: {
          runtime: {
            onMessage: {
              addListener: (
                listener: (
                  message: unknown,
                  sender: unknown,
                  respond: (value: unknown) => void,
                ) => void,
              ) => {
                (
                  window as typeof window & {
                    __inlineListeners: Array<typeof listener>;
                  }
                ).__inlineListeners.push(listener);
              },
            },
          },
        },
      });
    });
    await page.goto(`${site.url}?case=long-list`);
    const baselineWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    await page.addScriptTag({ path: resolve('.output/chrome-mv3/inline.js') });
    const result = (await page.evaluate(() => {
      let response: unknown;
      const listener = (
        window as typeof window & {
          __inlineListeners: Array<
            (
              message: unknown,
              sender: unknown,
              respond: (value: unknown) => void,
            ) => void
          >;
        }
      ).__inlineListeners[0]!;
      listener(
        {
          type: 'inline-activate',
          presentation: {
            theme: 'light',
            labels: {
              localOnly: 'Local only',
              loading: 'Loading',
              unavailable: 'Unavailable',
              identity: 'Magnet resource',
              fileCount: 'Files',
              size: 'Size',
            },
          },
        },
        {},
        (value) => {
          response = value;
        },
      );
      return response;
    })) as { mounted: number };
    expect(result.mounted).toBe(20);
    await expect(page.locator('[data-magnet-preview-inline]')).toHaveCount(20);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(baselineWidth + 32);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: resolve(evidence, 'inline-hostile-long-list.png'),
      fullPage: true,
    });
  } finally {
    await browser.close();
    await site.close();
  }
});
