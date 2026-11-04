import type { PreviewCache } from '../../application/previewCache';
import type { PreviewResult } from '../../domain/preview';

const MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const inFlightImages = new Map<string, Promise<Blob | null>>();

export function fetchApprovedScreenshot(
  sourceUrl: string,
  fetchImage: typeof fetch = fetch,
): Promise<Blob | null> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
    if (url.origin !== 'https://whatslink.info' || url.username || url.password)
      return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  const key = url.href;
  const pending = inFlightImages.get(key);
  if (pending) return pending;
  const task = readApprovedImage(key, fetchImage).finally(() => {
    if (inFlightImages.get(key) === task) inFlightImages.delete(key);
  });
  inFlightImages.set(key, task);
  return task;
}

async function readApprovedImage(
  url: string,
  fetchImage: typeof fetch,
): Promise<Blob | null> {
  try {
    const response = await fetchImage(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || !response.body) return null;
    const mime = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (!mime || !IMAGE_TYPES.has(mime)) {
      await response.body.cancel();
      return null;
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_BYTES) {
      await response.body.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (size === 0) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes.buffer], { type: mime });
  } catch {
    return null;
  }
}

// Best-effort only: preview metadata remains usable when images cannot be cached.
export async function persistScreenshots(
  result: PreviewResult,
  cache: PreviewCache,
  fetchImage: typeof fetch = fetch,
): Promise<void> {
  for (const image of result.screenshots.slice(0, 8)) {
    if (!image.sourceUrl || !/^[0-9]{1,2}$/.test(image.id)) continue;
    try {
      const blob = await fetchApprovedScreenshot(image.sourceUrl, fetchImage);
      if (!blob) continue;
      await cache.putAsset(result.infoHash + ':' + image.id, blob);
    } catch {
      // Offline, CORS, quota, and malformed responses must not break preview.
    }
  }
}
