import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import type { PreviewResult } from '../../src/domain/preview';
import { IndexedDbPreviewCache } from '../../src/infrastructure/storage/indexedDbPreviewCache';

const hash = (n: number) => n.toString(16).padStart(40, '0').toUpperCase();
const result = (n: number, screenshots = false): PreviewResult => ({
  infoHash: hash(n),
  magnet: 'magnet:?xt=urn:btih:' + hash(n),
  name: 'Resource ' + n,
  screenshots: screenshots
    ? [{ id: '0', sourceUrl: 'https://whatslink.info/screenshot/a.jpg' }]
    : [],
  providerId: 'whatslink',
  fetchedAt: 1,
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => vi.unstubAllGlobals());

describe('versioned IndexedDB preview cache', () => {
  it('persists metadata across adapter instances and normalizes the stored Magnet', async () => {
    const first = new IndexedDbPreviewCache(() => 1_000);
    const input = {
      ...result(1),
      magnet: 'magnet:?xt=urn:btih:' + hash(1) + '&dn=Private%20Title',
    };
    expect(await first.put(input)).toBe(true);
    const second = new IndexedDbPreviewCache(() => 2_000);
    expect(await second.get(hash(1))).toMatchObject({
      infoHash: hash(1),
      magnet: 'magnet:?xt=urn:btih:' + hash(1),
      name: 'Resource 1',
    });
    expect(await second.stats()).toMatchObject({
      previewCount: 1,
      screenshotCount: 0,
    });
  });

  it('uses a sliding seven-day TTL and removes an expired disposable result', async () => {
    const day = 24 * 60 * 60 * 1000;
    let now = 0;
    const cache = new IndexedDbPreviewCache(() => now);
    await cache.put(result(1));
    now = 6 * day;
    expect(await cache.get(hash(1))).not.toBeNull();
    now = 12 * day;
    expect(await cache.get(hash(1))).not.toBeNull();
    now = 20 * day;
    expect(await cache.get(hash(1))).toBeNull();
    expect((await cache.stats()).previewCount).toBe(0);
  });

  it('expires an untouched record after day eight', async () => {
    const day = 24 * 60 * 60 * 1000;
    let now = 0;
    const cache = new IndexedDbPreviewCache(() => now);
    await cache.put(result(1));
    now = 8 * day;
    expect(await cache.get(hash(1))).toBeNull();
    expect((await cache.stats()).previewCount).toBe(0);
  });

  it('allows a record to remain under the never-expire policy', async () => {
    const day = 24 * 60 * 60 * 1000;
    let now = 0;
    const cache = new IndexedDbPreviewCache(() => now);
    await cache.setPolicy({ schemaVersion: 1, ttlMs: null, capBytes: null });
    await cache.put(result(1));
    now = 365 * day;
    expect(await cache.get(hash(1))).not.toBeNull();
  });

  it('evicts the least recently used preview only after accounting for expiry', async () => {
    let now = 0;
    const cache = new IndexedDbPreviewCache(() => now);
    await cache.put(result(1));
    const size = (await cache.stats()).usedBytes;
    await cache.setPolicy({
      schemaVersion: 1,
      ttlMs: null,
      capBytes: size * 2 + 1,
    });
    now = 1;
    await cache.put(result(2));
    now = 2;
    expect(await cache.get(hash(1))).not.toBeNull();
    now = 3;
    await cache.put(result(3));
    expect(await cache.get(hash(1))).not.toBeNull();
    expect(await cache.get(hash(2))).toBeNull();
    expect(await cache.get(hash(3))).not.toBeNull();
    expect((await cache.stats()).previewCount).toBe(2);
  });

  it('retains bounded raster assets and clears them with disposable metadata', async () => {
    const cache = new IndexedDbPreviewCache(() => 1_000);
    await cache.put(result(1, true));
    const key = hash(1) + ':0';
    const blob = new Blob(['image-data'], { type: 'image/jpeg' });
    expect(await cache.putAsset(key, blob)).toBe(true);
    expect((await cache.get(hash(1)))?.screenshots[0]?.cachedAssetKey).toBe(
      key,
    );
    expect((await cache.getAsset(key))?.size).toBe(blob.size);
    expect(await cache.stats()).toMatchObject({
      previewCount: 1,
      screenshotCount: 1,
    });
    expect(await cache.putAsset(hash(1) + ':1', blob)).toBe(false);
    expect(
      await cache.putAsset(
        key,
        new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      ),
    ).toBe(false);
    await cache.clearDisposable();
    expect(await cache.get(hash(1))).toBeNull();
    expect(await cache.getAsset(key)).toBeNull();
    expect(await cache.getPolicy()).toMatchObject({
      schemaVersion: 1,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it('does not return remote screenshot URLs from a cache hit without local Blobs', async () => {
    const cache = new IndexedDbPreviewCache(() => 1_000);
    await cache.put(result(1, true));
    expect(await cache.get(hash(1))).toMatchObject({ screenshots: [] });
  });

  it('evicts a preview and its owned cache asset together under capacity pressure', async () => {
    const cache = new IndexedDbPreviewCache(() => 1_000);
    const imageResult = result(1, true);
    const otherResult = result(2);
    await cache.put(imageResult);
    const key = hash(1) + ':0';
    await cache.putAsset(
      key,
      new Blob(['cached-image'], { type: 'image/png' }),
    );
    const currentBytes = (await cache.stats()).usedBytes;
    const otherBytes = new TextEncoder().encode(
      JSON.stringify(otherResult),
    ).length;
    await cache.setPolicy({
      schemaVersion: 1,
      ttlMs: null,
      capBytes: currentBytes + otherBytes - 1,
    });

    expect(await cache.put(otherResult)).toBe(true);
    expect(await cache.get(hash(1))).toBeNull();
    expect(await cache.getAsset(key)).toBeNull();
    expect(await cache.get(hash(2))).not.toBeNull();
  });

  it('rejects oversized entries and accounts for storage policy changes', async () => {
    const cache = new IndexedDbPreviewCache(() => 100);
    await cache.setPolicy({ schemaVersion: 1, ttlMs: null, capBytes: 10 });
    expect(await cache.put(result(1))).toBe(false);
    expect((await cache.stats()).previewCount).toBe(0);
    await cache.setPolicy({ schemaVersion: 1, ttlMs: null, capBytes: null });
    expect(await cache.put(result(1, true))).toBe(true);
    expect(
      await cache.putAsset(
        hash(1) + ':0',
        new Blob([new ArrayBuffer(2 * 1024 * 1024 + 1)], { type: 'image/png' }),
      ),
    ).toBe(false);
    expect((await cache.stats()).screenshotCount).toBe(0);
    await cache.setPolicy({ schemaVersion: 1, ttlMs: null, capBytes: 0 });
    expect((await cache.stats()).previewCount).toBe(0);
  });

  it('deletes malformed stored accounting and treats it as a miss', async () => {
    const cache = new IndexedDbPreviewCache(() => 100);
    await cache.put(result(1));
    const request = indexedDB.open('magnet-preview-cache', 1);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('previews', 'readwrite');
        const previews = tx.objectStore('previews');
        const get = previews.get(hash(1));
        get.onsuccess = () => previews.put({ ...get.result, storedBytes: 123 });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(await cache.get(hash(1))).toBeNull();
    const verify = indexedDB.open('magnet-preview-cache', 1);
    const remaining = await new Promise<unknown>((resolve, reject) => {
      verify.onsuccess = () => {
        const db = verify.result;
        const get = db
          .transaction('previews')
          .objectStore('previews')
          .get(hash(1));
        get.onsuccess = () => {
          resolve(get.result);
          db.close();
        };
        get.onerror = () => reject(get.error);
      };
      verify.onerror = () => reject(verify.error);
    });
    expect(remaining).toBeUndefined();
  });

  it('removes a preview with a missing or invalid referenced Blob', async () => {
    const cache = new IndexedDbPreviewCache(() => 100);
    const key = hash(1) + ':0';
    await cache.put(result(1, true));
    await cache.putAsset(key, new Blob(['image'], { type: 'image/png' }));
    const request = indexedDB.open('magnet-preview-cache', 1);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').put({
          schemaVersion: 1,
          key,
          blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(await cache.get(hash(1))).toBeNull();
    expect((await cache.stats()).previewCount).toBe(0);
    expect(await cache.getAsset(key)).toBeNull();
  });

  it('cleans safely identifiable orphaned disposable assets during maintenance', async () => {
    const cache = new IndexedDbPreviewCache(() => 100);
    // Create the v1 stores before injecting an orphan directly into IndexedDB.
    await cache.getPolicy();
    const key = hash(1) + ':0';
    const request = indexedDB.open('magnet-preview-cache', 1);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').put({
          schemaVersion: 1,
          key,
          blob: new Blob(['orphan'], { type: 'image/png' }),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(await cache.stats()).toMatchObject({
      previewCount: 0,
      screenshotCount: 0,
    });
    expect(await cache.getAsset(key)).toBeNull();
  });

  it('does not downgrade or erase an unknown future schema', async () => {
    const request = indexedDB.open('magnet-preview-cache', 2);
    await new Promise<void>((resolve, reject) => {
      request.onupgradeneeded = () =>
        request.result.createObjectStore('future');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const cache = new IndexedDbPreviewCache();
    await expect(cache.getPolicy()).rejects.toBeTruthy();
    const reopened = indexedDB.open('magnet-preview-cache');
    const version = await new Promise<number>((resolve, reject) => {
      reopened.onsuccess = () => {
        resolve(reopened.result.version);
        reopened.result.close();
      };
      reopened.onerror = () => reject(reopened.error);
    });
    expect(version).toBe(2);
  });
});
