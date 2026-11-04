import { describe, expect, it, vi } from 'vitest';
import { ProductionPreviewManager } from '../../src/application/productionPreviewManager';
import {
  RequestCoordinator,
  defaultRequestPolicy,
} from '../../src/application/requestCoordinator';
import {
  defaultCachePolicy,
  type PreviewCache,
} from '../../src/application/previewCache';
import type { PreviewResult } from '../../src/domain/preview';
import { normalizeMagnet } from '../../src/domain/magnet';

const infoHash = '0123456789ABCDEF0123456789ABCDEF01234567';
const magnet = normalizeMagnet('magnet:?xt=urn:btih:' + infoHash)!;
const result: PreviewResult = {
  infoHash,
  magnet: 'magnet:?xt=urn:btih:' + infoHash,
  name: 'Cached resource',
  screenshots: [],
  providerId: 'whatslink',
  fetchedAt: 1,
};

function makeCache(overrides: Partial<PreviewCache> = {}): PreviewCache {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => true),
    getAsset: vi.fn(async () => null),
    putAsset: vi.fn(async () => true),
    getPolicy: vi.fn(async () => defaultCachePolicy),
    setPolicy: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({
      previewCount: 0,
      screenshotCount: 0,
      usedBytes: 0,
    })),
    clearDisposable: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('cache-first production PreviewManager', () => {
  it('requests only the five misses in a ten-resource batch', async () => {
    const magnets = Array.from({ length: 10 }, (_, n) =>
      normalizeMagnet(
        'magnet:?xt=urn:btih:' + n.toString(16).padStart(40, '0'),
      )!,
    );
    const get = vi.fn(async (hash: string) =>
      Number.parseInt(hash.slice(-1), 16) % 2 === 0
        ? { ...result, infoHash: hash, magnet: 'magnet:?xt=urn:btih:' + hash }
        : null,
    );
    const fetchPreview = vi.fn(async (hash: string) => ({
      ...result,
      infoHash: hash,
      magnet: 'magnet:?xt=urn:btih:' + hash,
    }));
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(
        { fetchPreview },
        { ...defaultRequestPolicy, spacingMs: 0 },
      ),
      makeCache({ get }),
    );
    expect(await manager.getMany(magnets)).toHaveLength(10);
    expect(get).toHaveBeenCalledTimes(10);
    expect(fetchPreview).toHaveBeenCalledTimes(5);
  });

  it('shares a normalized cache lookup and makes zero provider calls on a valid hit', async () => {
    let release!: (value: PreviewResult) => void;
    const get = vi.fn(
      () => new Promise<PreviewResult | null>((resolve) => (release = resolve)),
    );
    const cache = makeCache({ get });
    const fetchPreview = vi.fn(async () => result);
    const manager = new ProductionPreviewManager(
      new RequestCoordinator({ fetchPreview }),
      cache,
    );
    const first = manager.getPreview(magnet);
    const second = manager.getPreview(magnet);
    expect(first).toBe(second);
    expect(get).toHaveBeenCalledTimes(1);
    release(result);
    await expect(first).resolves.toMatchObject({ name: 'Cached resource' });
    expect(fetchPreview).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(manager.getState(infoHash).phase).toBe('success');
  });

  it('falls back to the provider when cache reads or writes fail', async () => {
    const cache = makeCache({
      get: vi.fn(async () => {
        throw new Error('IndexedDB unavailable');
      }),
      put: vi.fn(async () => {
        throw new Error('Quota exceeded');
      }),
    });
    const fetchPreview = vi.fn(async () => result);
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(
        { fetchPreview },
        { ...defaultRequestPolicy, spacingMs: 0 },
      ),
      cache,
    );
    await expect(manager.getPreview(magnet)).resolves.toMatchObject(result);
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it('returns the provider result before cache and screenshot persistence finish', async () => {
    let finishWrite!: (value: boolean) => void;
    let stored: PreviewResult | null = null;
    const put = vi.fn(
      (value: PreviewResult) =>
        new Promise<boolean>((resolve) => {
          finishWrite = (result) => {
            if (result) stored = value;
            resolve(result);
          };
        }),
    );
    const persistAssets = vi.fn(async () => undefined);
    const cache = makeCache({
      get: vi.fn(async () => stored),
      put,
    });
    const fetchPreview = vi.fn(async () => result);
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(
        { fetchPreview },
        { ...defaultRequestPolicy, spacingMs: 0 },
      ),
      cache,
      persistAssets,
    );

    await expect(manager.getPreview(magnet)).resolves.toMatchObject(result);
    expect(put).toHaveBeenCalledTimes(1);
    expect(persistAssets).not.toHaveBeenCalled();

    const repeated = manager.getPreview(magnet);
    finishWrite(true);
    await expect(repeated).resolves.toMatchObject(result);
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(persistAssets).toHaveBeenCalledTimes(1);
  });

  it('does not persist screenshot assets when metadata persistence fails', async () => {
    const cache = makeCache({ put: vi.fn(async () => false) });
    const persistAssets = vi.fn(async () => undefined);
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(
        { fetchPreview: async () => result },
        { ...defaultRequestPolicy, spacingMs: 0 },
      ),
      cache,
      persistAssets,
    );

    await expect(manager.getPreview(magnet)).resolves.toMatchObject(result);
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1));
    expect(persistAssets).not.toHaveBeenCalled();
  });
});
