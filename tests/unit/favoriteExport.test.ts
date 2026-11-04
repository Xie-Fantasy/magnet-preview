import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';
import type {
  FavoriteRecord,
  FavoriteStore,
} from '../../src/application/favorites';
import { exportFavorites } from '../../src/application/favoriteExport';

const hash = 'A'.repeat(40);
beforeEach(() => vi.stubGlobal('Blob', NodeBlob));
afterEach(() => vi.unstubAllGlobals());
const record: FavoriteRecord = {
  schemaVersion: 1,
  infoHash: hash,
  magnet: 'magnet:?xt=urn%3Abtih%3A' + hash + '&dn=Private+title',
  snapshot: {
    infoHash: hash,
    magnet: 'magnet:?xt=urn:btih:' + hash,
    name: '<script>alert(1)</script> & title',
    screenshots: [
      { id: '0', sourceUrl: 'https://whatslink.info/screenshot/test.png' },
    ],
    providerId: 'whatslink',
    fetchedAt: 1,
  },
  assetIds: ['0'],
  missingImageCount: 0,
  createdAt: 100,
  updatedAt: 200,
};

function store(asset: Blob | null): FavoriteStore {
  return {
    list: vi.fn(async () => [record]),
    getAsset: vi.fn(async () => asset),
  } as unknown as FavoriteStore;
}

describe('offline favorite export', () => {
  it('escapes source text and embeds images into standalone HTML', async () => {
    const file = await exportFavorites(
      store(new Blob(['png'], { type: 'image/png' })),
      'html',
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const html = await file.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; title');
    expect(html).toContain("script-src 'sha256-");
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('data:image/png;base64,cG5n');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('whatslink.info/screenshot');
  });

  it('lets an offline reader browse multiple owned images manually in both color modes', async () => {
    const images = {
      ...store(null),
      list: async () => [{ ...record, assetIds: ['0', '1', '2'] }],
      getAsset: vi.fn(
        async (_hash: string, id: string) =>
          new Blob([`image-${id}`], { type: 'image/png' }),
      ),
    };
    for (const format of ['html', 'zip'] as const) {
      const file = await exportFavorites(images, format);
      const html =
        format === 'html'
          ? await file.text()
          : strFromU8(
              unzipSync(new Uint8Array(await file.arrayBuffer()))[
                'collection/index.html'
              ]!,
            );
      const document = new DOMParser().parseFromString(html, 'text/html');
      expect(
        document.querySelector('.gallery')?.querySelectorAll('img'),
      ).toHaveLength(3);
      expect(
        document.querySelector('input#dark-mode[type="checkbox"]'),
      ).not.toBeNull();
      expect(document.querySelector('label[for="dark-mode"]')).not.toBeNull();
      expect(html).toContain('overflow-x:auto');
      expect(document.querySelectorAll('script')).toHaveLength(1);
      expect(document.querySelectorAll('[data-gallery-step]')).toHaveLength(2);
      const digest = createHash('sha256')
        .update(document.querySelector('script')!.textContent ?? '')
        .digest('base64');
      expect(
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content'),
      ).toContain(`script-src 'sha256-${digest}'`);
      expect(html).not.toContain("script-src 'unsafe-inline'");
      expect(
        document.querySelector('input#search[type="search"]'),
      ).not.toBeNull();
      expect(document.querySelector('button[data-copy]')).not.toBeNull();
      expect(
        document.querySelector('article[data-expanded="false"]'),
      ).not.toBeNull();
      expect(html).not.toContain('https://whatslink.info/screenshot');
    }
  });

  it('creates the versioned ZIP layout with safe generated paths', async () => {
    const file = await exportFavorites(
      store(new Blob(['png'], { type: 'image/png' })),
      'zip',
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(
      [
        'collection/README.txt',
        'collection/assets/' + hash + '/0.png',
        'collection/data.json',
        'collection/index.html',
      ].sort(),
    );
    const data = JSON.parse(strFromU8(files['collection/data.json']!));
    expect(data.schemaVersion).toBe(1);
    expect(data.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(data.items[0].assets).toEqual(['assets/' + hash + '/0.png']);
    expect(strFromU8(files['collection/index.html']!)).toContain(
      'src="assets/' + hash + '/0.png"',
    );
    expect(strFromU8(files['collection/data.json']!)).not.toContain(
      'whatslink.info/screenshot',
    );
  });

  it('uses the owned raster MIME for ZIP extension', async () => {
    for (const [mime, extension] of [
      ['image/jpeg', 'jpg'],
      ['image/webp', 'webp'],
      ['image/gif', 'gif'],
    ]) {
      const file = await exportFavorites(
        store(new Blob(['image'], { type: mime })),
        'zip',
      );
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      expect(entries[`collection/assets/${hash}/0.${extension}`]).toBeDefined();
    }
  });

  it('includes base64 assets in advanced JSON and reports unavailable ones', async () => {
    const available = JSON.parse(
      await (
        await exportFavorites(
          store(new Blob(['png'], { type: 'image/png' })),
          'json',
        )
      ).text(),
    );
    expect(available.assets['assets/' + hash + '/0.png']).toBe('cG5n');
    expect(JSON.stringify(available)).not.toContain(
      'whatslink.info/screenshot',
    );
    expect(available.items[0].snapshot.screenshots).toEqual([{ id: '0' }]);
    const missing = JSON.parse(
      await (await exportFavorites(store(null), 'json')).text(),
    );
    expect(missing.items[0].assets).toEqual([]);
    expect(missing.items[0].missingImageCount).toBe(1);
  });

  it('rejects collections above the bounded item count', async () => {
    const many = {
      ...store(null),
      list: async () => Array.from({ length: 1_001 }, () => record),
    };
    await expect(exportFavorites(many, 'zip')).rejects.toThrow(
      'too_many_favorites',
    );
  });

  it('rejects an empty collection instead of downloading an unexplained package', async () => {
    const empty = { ...store(null), list: async () => [] };
    await expect(exportFavorites(empty, 'html')).rejects.toThrow(
      'empty_favorites',
    );
  });

  it('exports only present assets from a partial favorite', async () => {
    const partial = {
      ...store(null),
      list: async () => [
        { ...record, assetIds: ['0', '1'], missingImageCount: 1 },
      ],
      getAsset: vi.fn(async (_hash: string, imageId: string) =>
        imageId === '0' ? new Blob(['png'], { type: 'image/png' }) : null,
      ),
    };
    const zipFile = await exportFavorites(partial, 'zip');
    const entries = unzipSync(new Uint8Array(await zipFile.arrayBuffer()));
    const data = JSON.parse(strFromU8(entries['collection/data.json']!));
    expect(data.items[0].assets).toEqual(['assets/' + hash + '/0.png']);
    expect(data.items[0].missingImageCount).toBe(2);
    expect(strFromU8(entries['collection/index.html']!)).not.toContain(
      'assets/' + hash + '/1.png',
    );
    expect(entries['collection/assets/' + hash + '/1.png']).toBeUndefined();
  });

  it('rejects unsafe asset paths and oversized owned images', async () => {
    const unsafe = {
      ...store(null),
      list: async () => [{ ...record, assetIds: ['../outside'] }],
    };
    await expect(exportFavorites(unsafe, 'zip')).rejects.toThrow(
      'invalid_favorite',
    );
    await expect(
      exportFavorites(
        store(
          new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], {
            type: 'image/png',
          }),
        ),
        'zip',
      ),
    ).rejects.toThrow('export_too_large');
  });

  it('localizes HTML and ZIP instructions while keeping JSON keys stable', async () => {
    const zhHtml = await exportFavorites(
      store(null),
      'html',
      undefined,
      'zh_CN',
    );
    expect(await zhHtml.text()).toContain('<html lang="zh-CN">');
    expect(await zhHtml.text()).toContain('Magnet Preview 收藏');
    expect(await zhHtml.text()).toContain('部分截图没有本地预览图片');
    const enHtml = await exportFavorites(store(null), 'html');
    expect(await enHtml.text()).toContain('<html lang="en">');
    const zhZip = await exportFavorites(store(null), 'zip', undefined, 'zh_CN');
    const entries = unzipSync(new Uint8Array(await zhZip.arrayBuffer()));
    expect(strFromU8(entries['collection/README.txt']!)).toContain(
      'V1 不支持导入或恢复',
    );
    const zhJson = JSON.parse(
      await (
        await exportFavorites(store(null), 'json', undefined, 'zh_CN')
      ).text(),
    );
    expect(Object.keys(zhJson).sort()).toEqual(
      ['assets', 'exportedAt', 'items', 'schemaVersion'].sort(),
    );
  });

  it('keeps hostile Unicode names as escaped text and falls back for malformed Magnet', async () => {
    const hostile = {
      ...store(null),
      list: async () => [
        {
          ...record,
          magnet: 'malformed <img onerror="alert(1)">',
          snapshot: { ...record.snapshot!, name: '电影 🎬 <script>" & title' },
          assetIds: [],
        },
      ],
    };
    const html = await (await exportFavorites(hostile, 'html')).text();
    expect(html).toContain('电影 🎬 &lt;script&gt;&quot; &amp; title');
    expect(html).not.toContain('<img onerror');
    const noName = {
      ...hostile,
      list: async () => [
        { ...record, magnet: 'malformed', snapshot: null, assetIds: [] },
      ],
    };
    expect(await (await exportFavorites(noName, 'html')).text()).toContain(
      `<h2>${hash}</h2>`,
    );
  });

  it('keeps a long Magnet as text without creating executable HTML', async () => {
    const longMagnet =
      record.magnet + '&dn=' + '<img onerror="alert(1)">🎬'.repeat(300);
    const long = {
      ...store(null),
      list: async () => [{ ...record, magnet: longMagnet, assetIds: [] }],
    };
    const html = await (await exportFavorites(long, 'html')).text();
    expect(html).toContain('&lt;img onerror=&quot;alert(1)&quot;&gt;🎬');
    expect(html).not.toContain('<img onerror');
  });

  it('rejects obvious HTML and JSON overflows before reading image bytes', async () => {
    const image = new Blob(['x'], { type: 'image/png' });
    Object.defineProperty(image, 'size', { value: 2 * 1024 * 1024 });
    const read = vi
      .spyOn(image, 'arrayBuffer')
      .mockResolvedValue(new ArrayBuffer(0));
    const images = {
      ...store(image),
      list: async () =>
        Array.from({ length: 4 }, (_, index) => ({
          ...record,
          infoHash: String(index).repeat(40),
          assetIds: Array.from({ length: 8 }, (_, imageId) => String(imageId)),
        })),
    };
    await expect(exportFavorites(images, 'html')).rejects.toThrow(
      'html_too_large',
    );
    expect(read.mock.calls.length).toBeLessThan(16);
    read.mockClear();
    await expect(exportFavorites(images, 'json')).rejects.toThrow(
      'json_too_large',
    );
    expect(read.mock.calls.length).toBeLessThan(32);
  });

  it('stops ZIP collection at the aggregate asset limit before the next read', async () => {
    const image = new Blob(['x'], { type: 'image/png' });
    Object.defineProperty(image, 'size', { value: 2 * 1024 * 1024 });
    const read = vi
      .spyOn(image, 'arrayBuffer')
      .mockResolvedValue(new ArrayBuffer(0));
    const manyImages = {
      ...store(image),
      list: async () =>
        Array.from({ length: 9 }, (_, index) => ({
          ...record,
          infoHash: String(index).repeat(40),
          assetIds: Array.from({ length: 8 }, (_, imageId) => String(imageId)),
        })),
    };
    await expect(exportFavorites(manyImages, 'zip')).rejects.toThrow(
      'export_too_large',
    );
    expect(read).toHaveBeenCalledTimes(64);
  });
});
