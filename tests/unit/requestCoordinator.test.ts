import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionPreviewManager } from '../../src/application/productionPreviewManager';
import {
  RequestCoordinator,
  defaultRequestPolicy,
} from '../../src/application/requestCoordinator';
import type { PreviewProvider } from '../../src/application/previewProvider';
import type { PreviewResult } from '../../src/domain/preview';
import { PreviewFailure } from '../../src/domain/previewFailure';
import { normalizeMagnet } from '../../src/domain/magnet';

const magnet = (n: number) =>
  normalizeMagnet('magnet:?xt=urn:btih:' + n.toString(16).padStart(40, '0'))!;
const result = (infoHash: string): PreviewResult => ({
  infoHash,
  magnet: 'magnet:?xt=urn:btih:' + infoHash,
  screenshots: [],
  providerId: 'fake',
  fetchedAt: 0,
});
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('request coordination', () => {
  it('shares in-flight hashes and does not cache completed responses', async () => {
    let release!: (value: PreviewResult) => void;
    const fetchPreview = vi.fn(
      () =>
        new Promise<PreviewResult>((resolve) => {
          release = resolve;
        }),
    );
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(
        { fetchPreview },
        { ...defaultRequestPolicy, spacingMs: 0 },
      ),
    );
    const first = manager.getPreview(magnet(1));
    const second = manager.getPreview(magnet(1));
    expect(first).toBe(second);
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    release(result(magnet(1).infoHash));
    await first;
    const third = manager.getPreview(magnet(1));
    release(result(magnet(1).infoHash));
    await third;
    expect(fetchPreview).toHaveBeenCalledTimes(2);
  });

  it('caps active requests at three and spaces starts for ten distinct hashes', async () => {
    const starts: number[] = [];
    const pending: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const provider: PreviewProvider = {
      fetchPreview: (hash) => {
        starts.push(Date.now());
        active += 1;
        maximum = Math.max(maximum, active);
        return new Promise<PreviewResult>((resolve) =>
          pending.push(() => {
            active -= 1;
            resolve(result(hash));
          }),
        );
      },
    };
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(provider),
    );
    const calls = Array.from({ length: 10 }, (_, n) =>
      manager.getPreview(magnet(n)),
    );
    await tick(1000);
    expect(starts).toEqual([0, 300, 600]);
    expect(maximum).toBe(3);
    for (let n = 0; n < 10; n += 1) {
      pending[n]?.();
      await tick(300);
    }
    await Promise.all(calls);
    expect(starts).toHaveLength(10);
    expect(
      starts.every(
        (time, index) => index === 0 || time - starts[index - 1]! >= 300,
      ),
    ).toBe(true);
    expect(maximum).toBe(3);
  });

  it('retries transient failures once, cleans up failure sharing, and leaves no-preview independent', async () => {
    const attempts = new Map<string, number>();
    const provider: PreviewProvider = {
      fetchPreview: async (hash) => {
        const count = (attempts.get(hash) ?? 0) + 1;
        attempts.set(hash, count);
        if (hash === magnet(1).infoHash && count === 1)
          throw new PreviewFailure('network', true);
        if (hash === magnet(2).infoHash)
          throw new PreviewFailure('not_found', false);
        return result(hash);
      },
    };
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(provider, {
        ...defaultRequestPolicy,
        spacingMs: 0,
      }),
    );
    const first = manager.getPreview(magnet(1));
    await tick(500);
    await expect(first).resolves.toMatchObject({
      infoHash: magnet(1).infoHash,
    });
    expect(attempts.get(magnet(1).infoHash)).toBe(2);
    const missing = manager.getPreview(magnet(2));
    await expect(missing).rejects.toMatchObject({ category: 'not_found' });
    expect(manager.getState(magnet(2).infoHash).phase).toBe('unavailable');
    await expect(manager.getPreview(magnet(2))).rejects.toMatchObject({
      category: 'not_found',
    });
    expect(attempts.get(magnet(2).infoHash)).toBe(2);
  });

  it('opens on 429, fast-fails queued requests, then admits one half-open probe', async () => {
    let calls = 0;
    const provider: PreviewProvider = {
      fetchPreview: async (hash) => {
        calls += 1;
        if (calls === 1) throw new PreviewFailure('rate_limited', false, 1000);
        return result(hash);
      },
    };
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(provider, {
        ...defaultRequestPolicy,
        spacingMs: 300,
      }),
    );
    const outcomes = await Promise.allSettled([
      manager.getPreview(magnet(1)),
      manager.getPreview(magnet(2)),
    ]);
    expect(outcomes.map((entry) => entry.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(calls).toBe(1);
    await expect(manager.getPreview(magnet(3))).rejects.toMatchObject({
      category: 'circuit_open',
    });
    await tick(1000);
    await expect(manager.getPreview(magnet(4))).resolves.toMatchObject({
      infoHash: magnet(4).infoHash,
    });
    expect(calls).toBe(2);
  });

  it('enforces timeout even if transport ignores AbortSignal, with one bounded retry', async () => {
    const fetchPreview = vi.fn(
      () => new Promise<PreviewResult>(() => undefined),
    );
    const coordinator = new RequestCoordinator(
      { fetchPreview },
      {
        ...defaultRequestPolicy,
        spacingMs: 0,
        timeoutMs: 80,
        retryDelayMs: 20,
      },
    );
    const manager = new ProductionPreviewManager(coordinator);
    const outcome = manager
      .getPreview(magnet(5))
      .catch((error: unknown) => error);
    await tick(181);
    await expect(outcome).resolves.toMatchObject({ category: 'timeout' });
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    expect(manager.getState(magnet(5).infoHash).phase).toBe('unavailable');
  });

  it('does not retry authorization failure and opens circuit', async () => {
    const fetchPreview = vi.fn(async () => {
      throw new PreviewFailure('authorization', false);
    });
    const manager = new ProductionPreviewManager(
      new RequestCoordinator({ fetchPreview }),
    );
    await expect(manager.getPreview(magnet(1))).rejects.toMatchObject({
      category: 'authorization',
    });
    await expect(manager.getPreview(magnet(2))).rejects.toMatchObject({
      category: 'circuit_open',
    });
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });

  it('reopens when half-open probe fails, without admitting a burst', async () => {
    const fetchPreview = vi.fn(async () => {
      throw new PreviewFailure('provider_unavailable', true);
    });
    const manager = new ProductionPreviewManager(
      new RequestCoordinator(
        { fetchPreview },
        {
          ...defaultRequestPolicy,
          spacingMs: 0,
          retryDelayMs: 0,
          transientThreshold: 1,
          cooldownMs: 100,
        },
      ),
    );
    const first = manager
      .getPreview(magnet(1))
      .catch((error: unknown) => error);
    await tick(0);
    await expect(first).resolves.toMatchObject({
      category: 'provider_unavailable',
    });
    await tick(100);
    await expect(manager.getPreview(magnet(2))).rejects.toMatchObject({
      category: 'provider_unavailable',
    });
    await expect(manager.getPreview(magnet(3))).rejects.toMatchObject({
      category: 'circuit_open',
    });
    expect(fetchPreview).toHaveBeenCalledTimes(3);
  });

  it('keeps seven successes usable when three resources have no preview', async () => {
    const fetchPreview = vi.fn(async (hash: string) => {
      if (Number.parseInt(hash.slice(-1), 16) >= 7)
        throw new PreviewFailure('not_found', false);
      return result(hash);
    });
    const manager = new ProductionPreviewManager(
      new RequestCoordinator({ fetchPreview }),
    );
    const outcomesPromise = Promise.allSettled(
      Array.from({ length: 10 }, (_, n) => manager.getPreview(magnet(n))),
    );
    await tick(3000);
    const outcomes = await outcomesPromise;
    expect(
      outcomes.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(7);
    expect(
      outcomes.filter((entry) => entry.status === 'rejected'),
    ).toHaveLength(3);
    expect(fetchPreview).toHaveBeenCalledTimes(10);
  });

  it('suppresses the remaining eight queued calls when a mid-page request returns 429', async () => {
    let releaseFirst!: (value: PreviewResult) => void;
    const fetchPreview = vi.fn((hash: string) => {
      if (hash === magnet(0).infoHash)
        return new Promise<PreviewResult>((resolve) => {
          releaseFirst = resolve;
        });
      throw new PreviewFailure('rate_limited', false, 3000);
    });
    const manager = new ProductionPreviewManager(
      new RequestCoordinator({ fetchPreview }),
    );
    const outcomesPromise = Promise.allSettled(
      Array.from({ length: 10 }, (_, n) => manager.getPreview(magnet(n))),
    );
    await tick(300);
    releaseFirst(result(magnet(0).infoHash));
    const outcomes = await outcomesPromise;
    expect(
      outcomes.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((entry) => entry.status === 'rejected'),
    ).toHaveLength(9);
    expect(fetchPreview).toHaveBeenCalledTimes(2);
  });
});
