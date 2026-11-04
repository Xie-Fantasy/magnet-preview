import { beforeEach, describe, expect, it } from 'vitest';
import {
  InlineRuntime,
  type InlinePresentation,
} from '../../src/content/inlineRuntime';

const hash = '0123456789ABCDEF0123456789ABCDEF01234567';
const presentation: InlinePresentation = {
  theme: 'light',
  labels: {
    localOnly: 'Local only',
    loading: 'Loading',
    unavailable: 'Unavailable',
    identity: 'Magnet resource',
    fileCount: 'Files',
    size: 'Size',
  },
};

describe('InlineRuntime', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main><a id="first" href="magnet:?xt=urn:btih:${hash}&dn=%E7%94%B5%E5%BD%B1">first</a><a id="second" href="magnet:?xt=urn:btih:${hash}">second</a><a href="magnet:?xt=urn:btih:bad">bad</a><p id="text">text magnet:?xt=urn:btih:${'2'.repeat(40)}</p></main>`;
  });

  it('mounts each eligible occurrence, keeps original nodes unchanged, refreshes idempotently, and removes only owned hosts', () => {
    const runtime = new InlineRuntime();
    const first = document.querySelector('#first')!;
    const original = first.outerHTML;
    const result = runtime.activate(presentation);
    expect(result.magnets).toHaveLength(2);
    expect(result.mounted).toBe(3);
    expect(
      document.querySelectorAll('[data-magnet-preview-inline]'),
    ).toHaveLength(3);
    expect(first.outerHTML).toBe(original);
    runtime.activate(presentation);
    expect(
      document.querySelectorAll('[data-magnet-preview-inline]'),
    ).toHaveLength(3);
    const added = document.createElement('a');
    added.href = `magnet:?xt=urn:btih:${'3'.repeat(40)}`;
    document.querySelector('main')!.append(added);
    expect(runtime.activate(presentation).mounted).toBe(4);
    runtime.remove();
    expect(
      document.querySelectorAll('[data-magnet-preview-inline]'),
    ).toHaveLength(0);
    expect(first.outerHTML).toBe(original);
    expect(runtime.activate(presentation).mounted).toBe(4);
  });

  it('renders provider data as text in a ShadowRoot and clears it when online previews are off', () => {
    const runtime = new InlineRuntime();
    runtime.activate(presentation, true);
    runtime.update(
      hash,
      { phase: 'success' },
      {
        name: '<img src=x onerror=alert(1)>',
        totalBytes: 1024,
        fileCount: 2,
      },
    );
    const hosts = [
      ...document.querySelectorAll<HTMLElement>('[data-magnet-preview-inline]'),
    ];
    expect(
      hosts
        .slice(0, 2)
        .map((host) => host.shadowRoot?.querySelector('.title')?.textContent),
    ).toEqual(['<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>']);
    expect(hosts[0]?.shadowRoot?.querySelector('img')).toBeNull();
    runtime.activate({ ...presentation, theme: 'dark' }, false);
    expect(hosts[0]?.dataset.theme).toBe('dark');
    expect(hosts[0]?.shadowRoot?.textContent).toContain('Local only');
    expect(hosts[0]?.shadowRoot?.textContent).not.toContain('<img src=x');
  });

  it('skips Magnet occurrences without a safe body sibling placement', () => {
    const link = document.createElement('link');
    link.href = `magnet:?xt=urn:btih:${'4'.repeat(40)}`;
    document.head.append(link);
    const text = document.createTextNode(
      `magnet:?xt=urn:btih:${'5'.repeat(40)}`,
    );
    document.body.append(text);
    try {
      const result = new InlineRuntime().activate(presentation);
      expect(result.mounted).toBe(3);
      expect(result.skipped).toBe(2);
      expect(result.magnets).toHaveLength(2);
      expect(
        link.nextElementSibling?.matches('[data-magnet-preview-inline]'),
      ).not.toBe(true);
    } finally {
      link.remove();
      text.remove();
    }
  });
});
