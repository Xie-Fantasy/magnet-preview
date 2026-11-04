import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HoverRuntime,
  type HoverPresentation,
} from '../../src/content/hoverRuntime';

const hash = '0123456789ABCDEF0123456789ABCDEF01234567';
const labels: HoverPresentation = {
  theme: 'light',
  labels: {
    loading: 'Loading',
    unavailable: 'Unavailable',
    localOnly: 'Local only',
    identity: 'Magnet',
    size: 'Size',
    fileCount: 'Files',
  },
};
const link = () => document.querySelector<HTMLElement>('#one')!;
const enter = () => link().dispatchEvent(new Event('pointerenter'));
const leave = () => link().dispatchEvent(new Event('pointerleave'));

describe('HoverRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><a id="one" href="magnet:?xt=urn:btih:${hash}">one</a><a href="magnet:?xt=urn:btih:${hash}">duplicate</a></main>`;
  });
  afterEach(() => {
    vi.useRealTimers();
    document.querySelector('magnet-preview-hover')?.remove();
  });

  it('cancels a quick pass without a request or panel', () => {
    const request = vi.fn();
    const runtime = new HoverRuntime(request);
    expect(runtime.activate('token', labels, true).hashes).toEqual([hash]);
    enter();
    vi.advanceTimersByTime(599);
    leave();
    vi.advanceTimersByTime(1000);
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('magnet-preview-hover')).toBeNull();
    runtime.remove();
  });

  it('requests only after intent, safely renders text, and removes listeners', async () => {
    const request = vi.fn().mockResolvedValue({
      name: '<script>bad</script>',
      totalBytes: 1024,
      fileCount: 2,
    });
    const runtime = new HoverRuntime(request);
    runtime.activate('token', labels, true);
    enter();
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    const host = document.querySelector<HTMLElement>('magnet-preview-hover')!;
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(hash, 'token');
    expect(host.shadowRoot?.querySelector('.title')?.textContent).toBe(
      '<script>bad</script>',
    );
    expect(host.shadowRoot?.querySelector('script')).toBeNull();
    runtime.remove();
    enter();
    vi.advanceTimersByTime(700);
    expect(request).toHaveBeenCalledOnce();
    expect(document.querySelector('magnet-preview-hover')).toBeNull();
  });

  it('keeps local-only activation off-network and handles repeated activation', () => {
    const request = vi.fn();
    const runtime = new HoverRuntime(request);
    runtime.activate('one', labels, false);
    runtime.activate('two', { ...labels, theme: 'dark' }, false);
    enter();
    vi.advanceTimersByTime(600);
    const host = document.querySelector<HTMLElement>('magnet-preview-hover')!;
    expect(host.dataset.theme).toBe('dark');
    expect(host.shadowRoot?.textContent).toContain('Local only');
    expect(request).not.toHaveBeenCalled();
    runtime.remove();
  });

  it('also opens for keyboard focus after the same intent delay', () => {
    const request = vi.fn();
    const runtime = new HoverRuntime(request);
    runtime.activate('token', labels, false);
    link().dispatchEvent(new Event('focusin'));
    vi.advanceTimersByTime(600);
    expect(document.querySelector('magnet-preview-hover')).not.toBeNull();
    link().dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(180);
    expect(document.querySelector('magnet-preview-hover')).toBeNull();
    runtime.remove();
  });

  it('does not stack Hover over an existing Inline preview for the same Magnet', () => {
    const request = vi.fn();
    const runtime = new HoverRuntime(request);
    runtime.activate('token', labels, true);
    const inline = document.createElement('magnet-preview-inline');
    inline.setAttribute('data-magnet-preview-inline', hash);
    link().insertAdjacentElement('afterend', inline);
    enter();
    vi.advanceTimersByTime(700);
    expect(document.querySelector('magnet-preview-hover')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    runtime.remove();
  });
});
