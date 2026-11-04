import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icons';

export function ScreenshotGallery({
  children,
  heading,
  className,
  t,
}: {
  children: ReactNode;
  heading?: ReactNode;
  className: string;
  t: (key: string) => string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const count = Children.toArray(children).length;
  const [position, setPosition] = useState({ index: 0, overflow: false });
  useEffect(() => {
    const node = strip.current!;
    const update = () => {
      const maximum = node.scrollWidth - node.clientWidth;
      const items = [...node.children] as HTMLElement[];
      const start = items[0]?.offsetLeft ?? 0;
      const index =
        maximum > 1 && node.scrollLeft >= maximum - 1
          ? items.length - 1
          : items.reduce(
              (nearest, item, index) =>
                Math.abs(item.offsetLeft - start - node.scrollLeft) <
                Math.abs(
                  (items[nearest]?.offsetLeft ?? start) -
                    start -
                    node.scrollLeft,
                )
                  ? index
                  : nearest,
              0,
            );
      setPosition({ index, overflow: maximum > 1 });
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      node.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [count]);
  const go = (index: number) => {
    const node = strip.current!;
    const items = [...node.children] as HTMLElement[];
    const item = items[Math.max(0, Math.min(index, items.length - 1))];
    if (item)
      node.scrollTo({
        left: item.offsetLeft - (items[0]?.offsetLeft ?? 0),
        behavior: 'instant',
      });
  };
  return (
    <div className="screenshot-gallery">
      <div className="screenshot-gallery-header">
        {heading}
        {count > 0 && (
          <div
            className="screenshot-gallery-controls"
            aria-label={t('previewScreenshots')}
          >
            <span className="screenshot-gallery-count">
              {position.overflow
                ? `${position.index + 1} / ${count}`
                : `${count}`}
            </span>
            {count > 1 && (
              <>
                <button
                  type="button"
                  aria-label={t('galleryPrevious')}
                  title={t('galleryPrevious')}
                  disabled={!position.overflow || position.index === 0}
                  onClick={() => go(position.index - 1)}
                >
                  <Icon name="previous" />
                </button>
                <button
                  type="button"
                  aria-label={t('galleryNext')}
                  title={t('galleryNext')}
                  disabled={!position.overflow || position.index === count - 1}
                  onClick={() => go(position.index + 1)}
                >
                  <Icon name="next" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div
        ref={strip}
        hidden={count === 0}
        className={className}
        role="group"
        aria-label={t('previewScreenshots')}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          const index =
            event.key === 'ArrowLeft'
              ? position.index - 1
              : event.key === 'ArrowRight'
                ? position.index + 1
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? count - 1
                    : undefined;
          if (index !== undefined && position.overflow) {
            event.preventDefault();
            go(index);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
