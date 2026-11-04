import { describe, expect, it, vi } from 'vitest';
import type { PreviewCache } from '../../src/application/previewCache';
import type { PreviewResult } from '../../src/domain/preview';
import {
  fetchApprovedScreenshot,
  persistScreenshots,
} from '../../src/infrastructure/storage/screenshotPersister';

const hash = 'A'.repeat(40);
const result: PreviewResult = {
  infoHash: hash,
  magnet: 'magnet:?xt=urn:btih:' + hash,
  screenshots: [
    { id: '0', sourceUrl: 'https://whatslink.info/screenshots/test.png' },
    { id: '1', sourceUrl: 'https://other.example/private.png' },
  ],
  providerId: 'whatslink',
  fetchedAt: 0,
};

describe('screenshot persistence', () => {
  it('shares an approved in-flight image and rejects arbitrary origins', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImage = vi.fn().mockReturnValue(pending);
    const url = 'https://whatslink.info/screenshots/shared.png';
    const first = fetchApprovedScreenshot(url, fetchImage);
    const second = fetchApprovedScreenshot(url, fetchImage);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    release(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    expect((await first)?.size).toBe(3);
    expect((await second)?.size).toBe(3);
    expect(
      await fetchApprovedScreenshot(
        'https://other.example/screenshot.png',
        fetchImage,
      ),
    ).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('fetches only a bounded same-origin raster without credentials or referrer', async () => {
    const putAsset = vi.fn().mockResolvedValue(true);
    const fetchImage = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    await persistScreenshots(
      result,
      { putAsset } as unknown as PreviewCache,
      fetchImage,
    );
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledWith(
      'https://whatslink.info/screenshots/test.png',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    );
    expect(putAsset).toHaveBeenCalledWith(hash + ':0', expect.any(Blob));
  });

  it('skips non-raster and oversized bodies without storing assets', async () => {
    const putAsset = vi.fn();
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'image/png' },
        }),
      );
    await persistScreenshots(
      { ...result, screenshots: [result.screenshots[0]!] },
      { putAsset } as unknown as PreviewCache,
      fetchImage,
    );
    await persistScreenshots(
      { ...result, screenshots: [result.screenshots[0]!] },
      { putAsset } as unknown as PreviewCache,
      fetchImage,
    );
    expect(putAsset).not.toHaveBeenCalled();
  });
});
