import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScreenshotGallery } from '../../src/shared/ScreenshotGallery';

afterEach(cleanup);
const t = (key: string) => key;

describe('manual screenshot gallery', () => {
  it('reaches the final image even when its start cannot align at the viewport edge', () => {
    render(
      <ScreenshotGallery className="images" t={t}>
        <div>A</div>
        <div>B</div>
        <div>C</div>
      </ScreenshotGallery>,
    );
    const strip = screen.getByRole('group');
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { value: 600 },
    });
    [...strip.children].forEach((child, index) =>
      Object.defineProperty(child, 'offsetLeft', { value: index * 200 }),
    );
    strip.scrollTo = vi.fn((options: ScrollToOptions) => {
      strip.scrollLeft = Math.max(0, Math.min(options.left ?? 0, 300));
      fireEvent.scroll(strip);
    }) as typeof strip.scrollTo;
    fireEvent.resize(window);
    const next = screen.getByRole('button', { name: 'galleryNext' });
    const previous = screen.getByRole('button', { name: 'galleryPrevious' });
    expect(previous).toHaveProperty('disabled', true);
    fireEvent.click(next);
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.click(next);
    expect(strip.scrollLeft).toBe(300);
    expect(screen.getByText('3 / 3')).toBeTruthy();
    expect(next).toHaveProperty('disabled', true);
    fireEvent.keyDown(strip, { key: 'Home' });
    expect(strip.scrollLeft).toBe(0);
    fireEvent.keyDown(strip, { key: 'End' });
    expect(strip.scrollLeft).toBe(300);
    Object.defineProperty(strip, 'clientWidth', { value: 600 });
    fireEvent.resize(window);
    expect(next).toHaveProperty('disabled', true);
    expect(previous).toHaveProperty('disabled', true);
  });
  it('keeps a zero-image heading without empty browsing controls', () => {
    render(
      <ScreenshotGallery className="images" t={t} heading={<h2>Preview</h2>}>
        {null}
      </ScreenshotGallery>,
    );
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
