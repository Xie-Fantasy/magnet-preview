export interface NormalizedMagnet {
  originalMagnet: string;
  canonicalMagnet: string;
  infoHash: string;
  displayName?: string;
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value: string): string | undefined {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (const character of value.toUpperCase()) {
    const index = base32Alphabet.indexOf(character);
    if (index === -1) return undefined;
    buffer = (buffer << 5) | index;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }

  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return undefined;
  if (bytes.length !== 20) return undefined;
  return bytes
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function normalizeInfoHash(value: string): string | undefined {
  const decoded = value.trim();
  if (/^[a-f\d]{40}$/i.test(decoded)) return decoded.toUpperCase();
  if (/^[a-z2-7]{32}$/i.test(decoded)) return base32ToHex(decoded);
  return undefined;
}

function decodeDisplayName(value: string | null): string | undefined {
  const name = value?.trim();
  return name || undefined;
}

export function normalizeMagnet(value: string): NormalizedMagnet | undefined {
  if (!value.trim().toLowerCase().startsWith('magnet:?')) return undefined;

  try {
    const url = new URL(value.trim());
    if (url.protocol.toLowerCase() !== 'magnet:') return undefined;
    const infoHash = [...url.searchParams.getAll('xt')]
      .map((xt) => /^urn:btih:(.+)$/i.exec(xt)?.[1])
      .map((hash) => (hash ? normalizeInfoHash(hash) : undefined))
      .find((hash): hash is string => hash !== undefined);
    if (!infoHash) return undefined;

    const displayName = decodeDisplayName(url.searchParams.get('dn'));
    const canonicalParams = new URLSearchParams({ xt: `urn:btih:${infoHash}` });
    if (displayName) canonicalParams.set('dn', displayName);
    return {
      originalMagnet: value,
      canonicalMagnet: `magnet:?${canonicalParams.toString()}`,
      infoHash,
      displayName,
    };
  } catch {
    return undefined;
  }
}
