import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { PreviewResult } from '../../src/domain/preview';
import { IndexedDbFavorites } from '../../src/infrastructure/storage/indexedDbFavorites';
import { IndexedDbPreviewCache } from '../../src/infrastructure/storage/indexedDbPreviewCache';

const hash = 'A'.repeat(40);
const magnet = 'magnet:?xt=urn:btih:' + hash + '&dn=Private%20title';
const preview: PreviewResult = {
  infoHash: hash,
  magnet,
  name: 'Preview title',
  screenshots: [
    { id: '0', sourceUrl: 'https://whatslink.info/screenshot/a.png' },
  ],
  providerId: 'whatslink',
  fetchedAt: 1,
};

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => vi.unstubAllGlobals());

describe('durable favorites', () => {
  it('finishes an early save with its own approved image before reporting success', async () => {
    const getAsset = vi.fn().mockResolvedValue(null);
    const acquire = vi
      .fn()
      .mockResolvedValue(new Blob(['owned-image'], { type: 'image/png' }));
    const favorites = new IndexedDbFavorites({ getAsset }, () => 100, acquire);
    const saved = await favorites.save(magnet, preview);
    expect(getAsset).toHaveBeenCalledWith(hash + ':0');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(saved.assetIds).toEqual(['0']);
    expect(saved.missingImageCount).toBe(0);
    expect(saved.snapshot?.screenshots).toEqual([{ id: '0' }]);
    expect(JSON.stringify(saved)).not.toContain('whatslink.info/screenshot');
    const restarted = new IndexedDbFavorites({ getAsset });
    expect((await restarted.getAsset(hash, '0'))?.size).toBe(11);
    expect((await restarted.get(hash))?.snapshot?.screenshots).toEqual([
      { id: '0' },
    ]);
  });

  it('keeps one canonical record across Magnet variants and repeat saves', async () => {
    const cache = { getAsset: vi.fn().mockResolvedValue(null) };
    const acquire = vi
      .fn()
      .mockResolvedValue(new Blob(['owned'], { type: 'image/png' }));
    let now = 100;
    const favorites = new IndexedDbFavorites(cache, () => now, acquire);
    await favorites.save(magnet, preview);
    now = 200;
    const variant = `magnet:?tr=https%3A%2F%2Ftracker.example&dn=Renamed&xt=urn:btih:${hash.toLowerCase()}`;
    const updated = await favorites.save(variant, preview);
    expect((await favorites.list()).map((item) => item.infoHash)).toEqual([
      hash,
    ]);
    expect(updated.createdAt).toBe(100);
    expect(updated.updatedAt).toBe(200);
    expect(updated.assetIds).toEqual(['0']);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('records a partial image save without inventing an offline asset', async () => {
    const cache = { getAsset: vi.fn().mockResolvedValue(null) };
    const favorites = new IndexedDbFavorites(
      cache,
      () => 100,
      vi.fn().mockResolvedValue(null),
    );
    const saved = await favorites.save(magnet, preview);
    expect(saved.missingImageCount).toBe(1);
    expect(saved.assetIds).toEqual([]);
    expect(await favorites.getAsset(hash, '0')).toBeNull();
    expect((await favorites.get(hash))?.snapshot?.name).toBe('Preview title');
  });

  it('copies available images into independent storage and survives cache cleanup', async () => {
    const cache = new IndexedDbPreviewCache(() => 100);
    await cache.put(preview);
    await cache.putAsset(
      hash + ':0',
      new Blob(['image'], { type: 'image/png' }),
    );
    const favorites = new IndexedDbFavorites(cache, () => 200);
    const saved = await favorites.save(magnet, preview);
    expect(saved.assetIds).toEqual(['0']);
    expect(saved.missingImageCount).toBe(0);
    expect(new URL(saved.magnet).searchParams.get('dn')).toBe('Private title');
    await cache.clearDisposable();
    const reopened = new IndexedDbFavorites(cache, () => 300);
    expect((await reopened.get(hash))?.snapshot?.name).toBe('Preview title');
    expect((await reopened.getAsset(hash, '0'))?.size).toBe(5);
    expect(await reopened.list()).toHaveLength(1);
    await reopened.remove(hash);
    expect(await reopened.get(hash)).toBeNull();
    expect(await reopened.getAsset(hash, '0')).toBeNull();
  });

  it('saves a local-only Magnet and marks unavailable screenshot assets honestly', async () => {
    const cache = new IndexedDbPreviewCache();
    const favorites = new IndexedDbFavorites(cache, () => 100);
    const first = await favorites.save(magnet);
    expect(first.snapshot).toBeNull();
    expect(first.assetIds).toEqual([]);
    const second = await favorites.save(magnet, preview);
    expect(second.createdAt).toBe(100);
    expect(second.missingImageCount).toBe(1);
    await expect(
      favorites.save('https://example.com', preview),
    ).rejects.toThrow();
    await expect(
      favorites.save(magnet, { ...preview, infoHash: 'B'.repeat(40) }),
    ).rejects.toThrow();
  });

  it('refuses a future schema without erasing its data', async () => {
    const request = indexedDB.open('magnet-favorites', 2);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () =>
        request.result.createObjectStore('future');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const favorites = new IndexedDbFavorites(new IndexedDbPreviewCache());
    await expect(favorites.list()).rejects.toBeTruthy();
    const reopened = indexedDB.open('magnet-favorites');
    expect(
      await new Promise<number>((resolve, reject) => {
        reopened.onsuccess = () => {
          resolve(reopened.result.version);
          reopened.result.close();
        };
        reopened.onerror = () => reject(reopened.error);
      }),
    ).toBe(2);
  });

  it('preserves owned images after cache expiry and LRU eviction', async () => {
    let now = 100;
    const cache = new IndexedDbPreviewCache(() => now);
    await cache.put(preview);
    await cache.putAsset(
      hash + ':0',
      new Blob(['owned-image'], { type: 'image/png' }),
    );
    const favorites = new IndexedDbFavorites(cache);
    await favorites.save(magnet, preview);
    await cache.setPolicy({ schemaVersion: 1, ttlMs: 60_000, capBytes: null });
    now = 60_101;
    expect(await cache.get(hash)).toBeNull();
    expect((await favorites.getAsset(hash, '0'))?.size).toBe(11);

    now = 100_000;
    await cache.setPolicy({ schemaVersion: 1, ttlMs: null, capBytes: null });
    await cache.put(preview);
    const otherHash = 'B'.repeat(40);
    const other: PreviewResult = {
      ...preview,
      infoHash: otherHash,
      magnet: 'magnet:?xt=urn:btih:' + otherHash,
      screenshots: [],
    };
    const currentBytes = (await cache.stats()).usedBytes;
    const otherBytes = new TextEncoder().encode(JSON.stringify(other)).length;
    await cache.setPolicy({
      schemaVersion: 1,
      ttlMs: null,
      capBytes: currentBytes + otherBytes - 1,
    });
    await cache.put(other);
    expect(await cache.get(hash)).toBeNull();
    expect((await favorites.getAsset(hash, '0'))?.size).toBe(11);
    expect((await favorites.get(hash))?.infoHash).toBe(hash);
  });

  it('removes only the favorite and its assets, leaving a valid cache hit', async () => {
    const cache = new IndexedDbPreviewCache();
    await cache.put(preview);
    await cache.putAsset(
      hash + ':0',
      new Blob(['owned-image'], { type: 'image/png' }),
    );
    const favorites = new IndexedDbFavorites(cache);
    await favorites.save(magnet, preview);
    await favorites.remove(hash);
    expect(await favorites.get(hash)).toBeNull();
    expect(await favorites.getAsset(hash, '0')).toBeNull();
    expect(await cache.get(hash)).not.toBeNull();
    expect(await cache.getAsset(hash + ':0')).not.toBeNull();
  });

  it('rolls back owned assets when the favorite record cannot commit', async () => {
    const cache = {
      getAsset: vi
        .fn()
        .mockResolvedValue(new Blob(['owned'], { type: 'image/png' })),
    };
    const favorites = new IndexedDbFavorites(cache);
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (this: IDBObjectStore, value, key) {
        const request =
          key === undefined
            ? originalPut.call(this, value)
            : originalPut.call(this, value, key);
        if (this.name === 'favorites')
          throw new DOMException('No space', 'QuotaExceededError');
        return request;
      });
    try {
      await expect(favorites.save(magnet, preview)).rejects.toBeTruthy();
    } finally {
      put.mockRestore();
    }
    expect(await favorites.get(hash)).toBeNull();
    expect(await favorites.getAsset(hash, '0')).toBeNull();
  });

  it('rejects a future record schema and retains it without overwriting', async () => {
    const favorites = new IndexedDbFavorites(new IndexedDbPreviewCache());
    await favorites.list();
    const request = indexedDB.open('magnet-favorites', 1);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').put({
          schemaVersion: 99,
          infoHash: hash,
          magnet,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    await expect(favorites.get(hash)).rejects.toBeTruthy();
    await expect(favorites.save(magnet)).rejects.toBeTruthy();
    await expect(favorites.remove(hash)).rejects.toBeTruthy();
    const check = indexedDB.open('magnet-favorites', 1);
    expect(
      await new Promise<number>((resolve, reject) => {
        check.onsuccess = () => {
          const db = check.result;
          const get = db
            .transaction('favorites')
            .objectStore('favorites')
            .get(hash);
          get.onsuccess = () => {
            resolve(get.result.schemaVersion);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
        check.onerror = () => reject(check.error);
      }),
    ).toBe(99);
  });

  it('removes malformed records and their owned orphan assets on lookup', async () => {
    const favorites = new IndexedDbFavorites(new IndexedDbPreviewCache());
    await favorites.list();
    const request = indexedDB.open('magnet-favorites', 1);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['favorites', 'assets'], 'readwrite');
        tx.objectStore('favorites').put({
          schemaVersion: 1,
          infoHash: hash,
          magnet: 'broken',
        });
        tx.objectStore('assets').put(
          new Blob(['orphan'], { type: 'image/png' }),
          hash + ':0',
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(await favorites.get(hash)).toBeNull();
    expect(await favorites.getAsset(hash, '0')).toBeNull();
  });

  it('repairs pre-acceptance snapshots that persisted remote image URLs', async () => {
    const favorites = new IndexedDbFavorites(new IndexedDbPreviewCache());
    await favorites.save(magnet, preview);
    const request = indexedDB.open('magnet-favorites', 1);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('favorites', 'readwrite');
        const store = tx.objectStore('favorites');
        const get = store.get(hash);
        get.onsuccess = () => {
          get.result.snapshot.screenshots[0].sourceUrl =
            'https://whatslink.info/screenshot/legacy.png?token=private';
          store.put(get.result);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect((await favorites.get(hash))?.snapshot?.screenshots).toEqual([
      { id: '0' },
    ]);
    const check = indexedDB.open('magnet-favorites', 1);
    const raw = await new Promise<unknown>((resolve, reject) => {
      check.onsuccess = () => {
        const db = check.result;
        const get = db
          .transaction('favorites')
          .objectStore('favorites')
          .get(hash);
        get.onsuccess = () => {
          resolve(get.result);
          db.close();
        };
        get.onerror = () => reject(get.error);
      };
      check.onerror = () => reject(check.error);
    });
    expect(JSON.stringify(raw)).not.toContain('token=private');
  });
});
