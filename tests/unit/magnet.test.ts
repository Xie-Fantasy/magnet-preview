import { describe, expect, it } from 'vitest';
import { normalizeMagnet } from '../../src/domain/magnet';

const hex = '0123456789abcdef0123456789abcdef01234567';

describe('normalizeMagnet', () => {
  it('uses uppercase hexadecimal infohash identity despite parameter ordering and case', () => {
    const first = normalizeMagnet(
      `magnet:?xt=urn:btih:${hex.toUpperCase()}&tr=https%3A%2F%2Fa.example`,
    );
    const second = normalizeMagnet(
      `magnet:?dn=Movie&tr=https%3A%2F%2Fb.example&xt=urn%3Abtih%3A${hex}`,
    );
    expect(first?.infoHash).toBe('0123456789ABCDEF0123456789ABCDEF01234567');
    expect(second?.infoHash).toBe(first?.infoHash);
    expect(second?.canonicalMagnet).toBe(
      `magnet:?xt=urn%3Abtih%3A${first?.infoHash}&dn=Movie`,
    );
  });

  it('decodes a valid base32 btih to the same twenty-byte identity', () => {
    const normalized = normalizeMagnet(
      'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(normalized?.infoHash).toBe(
      '0000000000000000000000000000000000000000',
    );
  });

  it('preserves a decoded Unicode display name without tracker duplication', () => {
    const normalized = normalizeMagnet(
      `magnet:?tr=x&dn=%E7%94%B5%E5%BD%B1%20%F0%9F%8E%AC&xt=urn:btih:${hex}&tr=x`,
    );
    expect(normalized?.displayName).toBe('电影 🎬');
    expect(normalized?.canonicalMagnet).not.toContain('tr=');
  });

  it('rejects malformed and unsupported magnets without throwing', () => {
    for (const value of [
      'https://example.test',
      'magnet:?dn=missing',
      'magnet:?xt=urn:btih:not-a-hash',
      'magnet:?xt=%E0%A4%A',
    ]) {
      expect(normalizeMagnet(value)).toBeUndefined();
    }
  });
});
