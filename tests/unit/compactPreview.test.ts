import { describe, expect, it } from 'vitest';
import {
  compactIdentity,
  compactThumbnail,
} from '../../src/content/compactPreview';

describe('compact page preview presentation', () => {
  it('keeps the media frame and decorative vector when a local image fails', () => {
    const frame = compactThumbnail(
      'data:image/png;base64,broken',
      '<b>title</b>',
    );
    const image = frame.querySelector('img')!;
    expect(image.alt).toBe('<b>title</b>');
    expect(frame.querySelector('b')).toBeNull();
    image.dispatchEvent(new Event('error'));
    expect(frame.className).toBe('media');
    expect(frame.querySelector('img')).toBeNull();
    expect(frame.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      compactThumbnail(
        'https://untrusted.test/image.png',
        'Title',
      ).querySelector('img'),
    ).toBeNull();
  });
  it('makes the full hash available without putting it ahead of primary metadata', () => {
    const hash = 'A'.repeat(40);
    const identity = compactIdentity(hash, 'Magnet resource');
    expect(identity.tagName).toBe('CODE');
    expect(identity.textContent).toBe('A'.repeat(12) + '…');
    expect(identity.title).toBe(hash);
    expect(identity.getAttribute('aria-label')).toBe('Magnet resource');
  });
});
