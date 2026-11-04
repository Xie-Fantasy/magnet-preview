import { describe, expect, it } from 'vitest';
import { scanMagnets } from '../../src/content/magnetScanner';

const hashA = '0123456789abcdef0123456789abcdef01234567';
const hashB = '1111111111111111111111111111111111111111';

function page(body: string): Document {
  return new DOMParser().parseFromString(body, 'text/html');
}

describe('scanMagnets', () => {
  it('returns nothing for pages without valid Magnets', () => {
    expect(
      scanMagnets(page('<a href="https://example.test">ordinary</a>')).magnets,
    ).toEqual([]);
  });

  it('finds href and safe text occurrences, then deduplicates by normalized InfoHash', () => {
    const document = page(
      `<main class="odd"><a href="magnet:?xt=urn:btih:${hashA}">one</a><a href="/jump#magnet:?dn=Name&xt=urn:btih:${hashA}">two</a><p>text magnet:?dn=%E7%94%B5%E5%BD%B1&xt=urn:btih:${hashB}.</p><a href="magnet:?xt=urn:btih:bad">bad</a></main>`,
    );
    const before = document.body.innerHTML;
    const result = scanMagnets(document);
    expect(result.magnets).toHaveLength(2);
    expect(result.magnets[0]?.occurrences).toHaveLength(2);
    expect(result.magnets[1]?.magnet.displayName).toBe('电影');
    expect(result.occurrences.map((occurrence) => occurrence.source)).toEqual([
      'href',
      'href',
      'text',
    ]);
    expect(document.body.innerHTML).toBe(before);
  });

  it('ignores text inside non-page-content elements and survives long or modified content', () => {
    const document = page(
      `<script>magnet:?xt=urn:btih:${hashA}</script><p>magnet:?xt=urn:btih:${hashA}${'x'.repeat(9000)}</p>`,
    );
    document.body.append(
      document.createTextNode(` magnet:?xt=urn:btih:${hashB}`),
    );
    const result = scanMagnets(document);
    expect(result.magnets).toHaveLength(1);
    expect(result.magnets[0]?.magnet.infoHash).toBe(hashB.toUpperCase());
  });

  it('returns partial results and an occurrence-limit truncation reason without throwing', () => {
    const links = Array.from(
      { length: 1_001 },
      () => `<a href="magnet:?xt=urn:btih:${hashA}">x</a>`,
    ).join('');
    const result = scanMagnets(
      page(`${links}<p>magnet:?xt=urn:btih:${hashB}</p>`),
    );
    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'occurrence_limit',
    });
    expect(result.occurrences).toHaveLength(1_000);
    expect(result.magnets[0]?.magnet.infoHash).toBe(hashA.toUpperCase());
  });

  it('returns prior results when the text-node safety limit is reached', () => {
    const textNodes = Array.from(
      { length: 10_001 },
      () => '<span>ordinary</span>',
    ).join('');
    const result = scanMagnets(
      page(
        `<p>magnet:?xt=urn:btih:${hashA}</p>${textNodes}<p>magnet:?xt=urn:btih:${hashB}</p>`,
      ),
    );
    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'text_node_limit',
    });
    expect(result.magnets.map((item) => item.magnet.infoHash)).toContain(
      hashA.toUpperCase(),
    );
    expect(result.magnets.map((item) => item.magnet.infoHash)).not.toContain(
      hashB.toUpperCase(),
    );
  });
});
