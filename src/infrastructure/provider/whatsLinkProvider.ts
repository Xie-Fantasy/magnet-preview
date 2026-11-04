import type { PreviewProvider } from '../../application/previewProvider';
import { PreviewFailure } from '../../domain/previewFailure';
import type { PreviewImage, PreviewResult } from '../../domain/preview';

export const WHATS_LINK_ORIGIN = 'https://whatslink.info';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SCREENSHOTS = 24;

type Transport = typeof fetch;

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (
    Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    Number.isSafeInteger(seconds * 1000)
  )
    return seconds * 1000;
  if (
    !/^[A-Za-z]{3},\s\d{2}\s[A-Za-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT$/i.test(
      value.trim(),
    )
  )
    return undefined;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function safeScreenshot(
  value: unknown,
  index: number,
): PreviewImage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.screenshot !== 'string') return undefined;
  try {
    const url = new URL(input.screenshot, WHATS_LINK_ORIGIN);
    if (
      url.origin !== WHATS_LINK_ORIGIN ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password
    )
      return undefined;
    return { id: String(index), sourceUrl: url.href };
  } catch {
    return undefined;
  }
}

export function parseWhatsLinkResponse(
  value: unknown,
  infoHash: string,
  now = Date.now(),
): PreviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PreviewFailure('invalid_response', false);
  const input = value as Record<string, unknown>;
  if (
    input.error !== null &&
    input.error !== undefined &&
    input.error !== false &&
    input.error !== ''
  ) {
    throw new PreviewFailure('not_found', false);
  }
  const name =
    typeof input.name === 'string' ? input.name.trim().slice(0, 500) : '';
  const totalBytes =
    typeof input.size === 'number' &&
    Number.isSafeInteger(input.size) &&
    input.size >= 0
      ? input.size
      : undefined;
  const fileCount =
    typeof input.count === 'number' &&
    Number.isSafeInteger(input.count) &&
    input.count >= 0
      ? input.count
      : undefined;
  const candidates = Array.isArray(input.screenshots)
    ? input.screenshots
        .slice(0, MAX_SCREENSHOTS)
        .map(safeScreenshot)
        .filter((item): item is PreviewImage => item !== undefined)
    : [];
  const seen = new Set<string>();
  const screenshots = candidates.filter((item) => {
    if (!item.sourceUrl || seen.has(item.sourceUrl)) return false;
    seen.add(item.sourceUrl);
    return true;
  });
  if (
    !name &&
    totalBytes === undefined &&
    fileCount === undefined &&
    screenshots.length === 0
  )
    throw new PreviewFailure('invalid_response', false);
  return {
    infoHash,
    magnet: 'magnet:?xt=urn:btih:' + infoHash,
    name: name || undefined,
    totalBytes,
    fileCount,
    screenshots,
    providerId: 'whatslink',
    fetchedAt: now,
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
      throw new PreviewFailure('invalid_response', false);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PreviewFailure('invalid_response', false);
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class WhatsLinkProvider implements PreviewProvider {
  constructor(
    private readonly transport?: Transport,
    private readonly now: () => number = Date.now,
  ) {}

  async fetchPreview(
    infoHash: string,
    signal: AbortSignal,
  ): Promise<PreviewResult> {
    if (!/^[A-F0-9]{40}$/.test(infoHash))
      throw new PreviewFailure('invalid_response', false);
    const url = new URL('/api/v1/link', WHATS_LINK_ORIGIN);
    url.searchParams.set('url', 'magnet:?xt=urn:btih:' + infoHash);
    let response: Response;
    try {
      response = await (this.transport ?? fetch)(url.href, {
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new PreviewFailure('timeout', true);
      if (error instanceof PreviewFailure) throw error;
      throw new PreviewFailure('network', true);
    }
    if (response.status === 429)
      throw new PreviewFailure(
        'rate_limited',
        false,
        parseRetryAfter(response.headers.get('Retry-After'), this.now()),
      );
    if (response.status === 401 || response.status === 403)
      throw new PreviewFailure('authorization', false);
    if (response.status === 404) throw new PreviewFailure('not_found', false);
    if (!response.ok)
      throw new PreviewFailure('provider_unavailable', response.status >= 500);
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > MAX_RESPONSE_BYTES)
      throw new PreviewFailure('invalid_response', false);
    let body: string;
    try {
      body = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof PreviewFailure) throw error;
      if (signal.aborted) throw new PreviewFailure('timeout', true);
      throw new PreviewFailure('network', true);
    }
    try {
      return parseWhatsLinkResponse(
        JSON.parse(body) as unknown,
        infoHash,
        this.now(),
      );
    } catch (error) {
      if (error instanceof PreviewFailure) throw error;
      throw new PreviewFailure('invalid_response', false);
    }
  }
}
