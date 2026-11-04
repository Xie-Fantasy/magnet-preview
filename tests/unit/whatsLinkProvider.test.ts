import { describe, expect, it, vi } from 'vitest';
import { PreviewFailure } from '../../src/domain/previewFailure';
import {
  parseRetryAfter,
  parseWhatsLinkResponse,
  WhatsLinkProvider,
} from '../../src/infrastructure/provider/whatsLinkProvider';
import { hash, video } from '../fixtures/whatslink';

describe('WhatsLink adapter', () => {
  it('normalizes only verified data and retains Unicode/large integer metadata', () => {
    const result = parseWhatsLinkResponse(video, hash, 10);
    expect(result).toMatchObject({
      infoHash: hash,
      providerId: 'whatslink',
      name: video.name,
      totalBytes: video.size,
      fileCount: 11,
      fetchedAt: 10,
    });
    expect(result.screenshots.map((image) => image.sourceUrl)).toHaveLength(2);
    expect(result.screenshots[0]?.timeSeconds).toBeUndefined();
    const large = parseWhatsLinkResponse(
      { name: 'large', size: 5_000_000_000_000, screenshots: [] },
      hash,
    );
    expect(large.totalBytes).toBe(5_000_000_000_000);
  });

  it('tolerates absent and malformed optional images but rejects cross-origin screenshots', () => {
    const result = parseWhatsLinkResponse(
      {
        name: 'safe',
        screenshots: [
          { screenshot: 'https://whatslink.info/a.png' },
          { screenshot: 'https://whatslink.info/a.png' },
          { screenshot: 'http://whatslink.info/insecure.png' },
          { screenshot: 'https://evil.example/unsafe.png' },
          { screenshot: 'javascript:alert(1)' },
          { screenshot: 'https://user:secret@whatslink.info/private.png' },
          null,
        ],
      },
      hash,
    );
    expect(result.screenshots).toHaveLength(1);
    expect(
      parseWhatsLinkResponse({ name: 'metadata only' }, hash).screenshots,
    ).toEqual([]);
    expect(() => parseWhatsLinkResponse({}, hash)).toThrow(PreviewFailure);
    expect(() => parseWhatsLinkResponse({ error: 'missing' }, hash)).toThrow(
      PreviewFailure,
    );
    expect(() => parseWhatsLinkResponse([], hash)).toThrow(PreviewFailure);
  });

  it('sends BTIH only, no cookies/referrer, and maps status without exposing raw body', async () => {
    const transport = vi.fn(
      async () => new Response(JSON.stringify(video), { status: 200 }),
    );
    const provider = new WhatsLinkProvider(transport, () => 123);
    const result = await provider.fetchPreview(
      hash,
      new AbortController().signal,
    );
    expect(result.name).toBe(video.name);
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(url).origin).toBe('https://whatslink.info');
    expect(new URL(url).searchParams.get('url')).toBe(
      'magnet:?xt=urn:btih:' + hash,
    );
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.redirect).toBe('error');
    for (const [status, category] of [
      [401, 'authorization'],
      [403, 'authorization'],
      [404, 'not_found'],
      [500, 'provider_unavailable'],
    ] as const) {
      const failed = new WhatsLinkProvider(
        async () => new Response('private provider text', { status }),
      );
      await expect(
        failed.fetchPreview(hash, new AbortController().signal),
      ).rejects.toMatchObject({ category });
    }
  });

  it('parses Retry-After delta/date and rejects invalid content', async () => {
    expect(parseRetryAfter('12', 0)).toBe(12_000);
    expect(parseRetryAfter('3600', 0)).toBe(3_600_000);
    expect(parseRetryAfter(new Date(20_000).toUTCString(), 0)).toBe(20_000);
    expect(parseRetryAfter('nonsense')).toBeUndefined();
    expect(parseRetryAfter('1.5')).toBeUndefined();
    const provider = new WhatsLinkProvider(
      async () =>
        new Response('', { status: 429, headers: { 'Retry-After': '12' } }),
    );
    await expect(
      provider.fetchPreview(hash, new AbortController().signal),
    ).rejects.toMatchObject({ category: 'rate_limited', retryAfterMs: 12_000 });
    const invalid = new WhatsLinkProvider(
      async () => new Response('{bad json', { status: 200 }),
    );
    await expect(
      invalid.fetchPreview(hash, new AbortController().signal),
    ).rejects.toMatchObject({ category: 'invalid_response' });
    const oversized = new WhatsLinkProvider(
      async () => new Response('x'.repeat(1_000_001), { status: 200 }),
    );
    await expect(
      oversized.fetchPreview(hash, new AbortController().signal),
    ).rejects.toMatchObject({ category: 'invalid_response' });
  });
});
