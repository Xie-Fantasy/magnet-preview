import { describe, expect, it } from 'vitest';
import { FakePreviewManager } from '../../src/application/fakePreviewManager';
import { normalizeMagnet } from '../../src/domain/magnet';

const magnet = normalizeMagnet(
  'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
)!;
describe('FakePreviewManager', () => {
  it('shares concurrent requests and exposes safe state transitions', async () => {
    const manager = new FakePreviewManager(
      new Map([
        [
          magnet.infoHash,
          {
            type: 'success',
            result: { screenshots: [], providerId: 'fake', fetchedAt: 1 },
          },
        ],
      ]),
    );
    const first = manager.getPreview(magnet);
    const second = manager.getPreview(magnet);
    expect(first).toBe(second);
    expect(manager.getState(magnet.infoHash).phase).toBe('queued');
    await expect(first).resolves.toMatchObject({
      infoHash: magnet.infoHash,
      providerId: 'fake',
    });
    expect(manager.getState(magnet.infoHash).phase).toBe('success');
  });
  it('maps fake failures to unavailable without raw UI error state', async () => {
    const manager = new FakePreviewManager(
      new Map([
        [magnet.infoHash, { type: 'unavailable', category: 'network_error' }],
      ]),
    );
    await expect(manager.getMany([magnet])).rejects.toThrow('network_error');
    expect(manager.getState(magnet.infoHash)).toEqual({
      phase: 'unavailable',
      technicalDetails: { category: 'network_error' },
    });
  });
});
