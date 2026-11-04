import { scanMagnets } from './magnetScanner';
import type { NormalizedMagnet } from '../domain/magnet';
import { isolatedThemeCss } from '../shared/isolatedTheme';
import { formatBytes } from '../shared/formatBytes';
import {
  compactPreviewCss,
  compactThumbnail,
  compactIdentity,
} from './compactPreview';

export interface HoverPresentation {
  theme: 'light' | 'dark';
  labels: {
    loading: string;
    unavailable: string;
    localOnly: string;
    identity: string;
    size: string;
    fileCount: string;
  };
}

export interface HoverSummary {
  name?: string;
  totalBytes?: number;
  fileCount?: number;
  thumbnail?: string;
}

type RequestPreview = (
  infoHash: string,
  token: string,
) => Promise<HoverSummary | null>;
const marker = 'data-magnet-preview-hover';
const delayMs = 600;
const styles = `
  ${isolatedThemeCss}
  ${compactPreviewCss}
  :host { all: initial; position: fixed !important; z-index: 2147483647 !important;
    display: block !important; pointer-events: auto !important; }
  *, *::before, *::after { box-sizing: border-box; }
  .card { color-scheme: light; font: 13px/1.5 system-ui, sans-serif; color: var(--mp-ink);
    background: var(--mp-surface); border: 1px solid var(--mp-line); border-radius: 8px; padding: 16px;
    box-shadow: 0 4px 16px #0002; overflow-wrap: anywhere;
    max-height: inherit; overflow: auto; display: flex; align-items: flex-start; gap: 12px; }
  :host([data-theme="dark"]) .card { color-scheme: dark; }
  .media { flex-basis: 80px; inline-size: 80px; block-size: 60px; }
`;

export class HoverRuntime {
  private targets = new Map<HTMLElement, NormalizedMagnet>();
  private host: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private active: HTMLElement | null = null;
  private token = '';
  private online = false;
  private presentation: HoverPresentation | null = null;
  private generation = 0;

  constructor(private readonly request: RequestPreview) {}

  isActive(token: string) {
    return token !== '' && this.token === token;
  }

  activate(token: string, presentation: HoverPresentation, online: boolean) {
    this.remove();
    this.token = token;
    this.presentation = presentation;
    this.online = online;
    const scan = scanMagnets(document, (occurrence, node) => {
      const element = node instanceof HTMLElement ? node : node.parentElement;
      if (
        !element ||
        element === document.body ||
        !document.body?.contains(element) ||
        element.closest(`[${marker}]`)
      )
        return;
      if (!this.targets.has(element))
        this.targets.set(element, occurrence.magnet);
    });
    for (const element of this.targets.keys()) {
      element.addEventListener('pointerenter', this.onEnter);
      element.addEventListener('pointerleave', this.onLeave);
      element.addEventListener('focusin', this.onEnter);
      element.addEventListener('focusout', this.onLeave);
    }
    window.addEventListener('scroll', this.reposition, true);
    window.addEventListener('resize', this.reposition);
    window.visualViewport?.addEventListener('scroll', this.reposition);
    window.visualViewport?.addEventListener('resize', this.reposition);
    return {
      count: this.targets.size,
      truncated: scan.truncated,
      hashes: [
        ...new Set([...this.targets.values()].map((item) => item.infoHash)),
      ],
    };
  }

  remove() {
    this.generation++;
    this.clearTimers();
    for (const element of this.targets.keys()) {
      element.removeEventListener('pointerenter', this.onEnter);
      element.removeEventListener('pointerleave', this.onLeave);
      element.removeEventListener('focusin', this.onEnter);
      element.removeEventListener('focusout', this.onLeave);
    }
    this.targets.clear();
    window.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('resize', this.reposition);
    window.visualViewport?.removeEventListener('scroll', this.reposition);
    window.visualViewport?.removeEventListener('resize', this.reposition);
    this.active = null;
    this.host?.remove();
    this.host = null;
    this.token = '';
    return { removed: true };
  }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.timer = null;
    this.hideTimer = null;
  }

  private readonly onEnter = (event: Event) => {
    const element = event.currentTarget as HTMLElement;
    const magnet = this.targets.get(element);
    if (
      magnet &&
      element.nextElementSibling?.getAttribute('data-magnet-preview-inline') ===
        magnet.infoHash
    ) {
      this.hide();
      return;
    }
    this.clearTimers();
    if (this.active === element && this.host) return;
    if (this.active !== element) this.hide();
    const generation = ++this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!element.isConnected || generation !== this.generation) return;
      if (
        element.nextElementSibling?.getAttribute(
          'data-magnet-preview-inline',
        ) === magnet?.infoHash
      )
        return;
      this.active = element;
      if (!magnet) return;
      this.render(magnet, undefined, this.online ? 'loading' : 'localOnly');
      if (!this.online) return;
      void this.request(magnet.infoHash, this.token).then(
        (summary) => {
          if (generation !== this.generation || this.active !== element) return;
          this.render(
            magnet,
            summary ?? undefined,
            summary ? '' : 'unavailable',
          );
        },
        () => {
          if (generation === this.generation && this.active === element)
            this.render(magnet, undefined, 'unavailable');
        },
      );
    }, delayMs);
  };

  private readonly onLeave = () => {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.generation++;
    }
    this.scheduleHide();
  };

  private scheduleHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), 180);
  }

  private hide() {
    this.generation++;
    this.active = null;
    this.host?.remove();
    this.host = null;
  }

  private readonly reposition = () => {
    if (!this.active?.isConnected) return this.hide();
    if (!this.host) return;
    const rect = this.active.getBoundingClientRect();
    const parsedZoom = Number.parseFloat(
      getComputedStyle(document.documentElement).zoom,
    );
    const zoom = Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : 1;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const width = Math.min(340 * zoom, viewportWidth - 16);
    this.host.style.setProperty('width', `${width / zoom}px`, 'important');
    this.host.style.setProperty(
      'max-height',
      `${(viewportHeight - 16) / zoom}px`,
      'important',
    );
    const left = Math.max(
      viewportLeft + 8,
      Math.min(rect.left, viewportLeft + viewportWidth - width - 8),
    );
    const height = this.host.getBoundingClientRect().height || 90;
    const below = rect.bottom + 8;
    const top =
      below + height <= viewportTop + viewportHeight - 8
        ? below
        : Math.max(viewportTop + 8, rect.top - height - 8);
    this.host.style.setProperty('left', `${left / zoom}px`, 'important');
    this.host.style.setProperty('top', `${top / zoom}px`, 'important');
    this.host.style.removeProperty('transform');
    const actualTop = this.host.getBoundingClientRect().top;
    if (Math.abs(actualTop - top) > 1) {
      // A zoomed document root can make a fixed child use that root as its
      // containing block. Measure the actual movement before correcting it.
      this.host.style.setProperty('transform', 'translateY(10px)', 'important');
      const shiftedTop = this.host.getBoundingClientRect().top;
      const pixelsPerCssPixel = (shiftedTop - actualTop) / 10;
      if (Number.isFinite(pixelsPerCssPixel) && pixelsPerCssPixel > 0)
        this.host.style.setProperty(
          'transform',
          `translateY(${(top - actualTop) / pixelsPerCssPixel}px)`,
          'important',
        );
    }
  };

  private render(
    magnet: NormalizedMagnet,
    summary?: HoverSummary,
    status: keyof HoverPresentation['labels'] | '' = '',
  ) {
    if (!this.presentation) return;
    if (!this.host) {
      this.host = document.createElement('magnet-preview-hover');
      this.host.setAttribute(marker, '');
      this.host.attachShadow({ mode: 'open' });
      this.host.addEventListener('pointerenter', () => {
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.hideTimer = null;
      });
      this.host.addEventListener('pointerleave', () => this.scheduleHide());
      document.body.append(this.host);
    }
    this.host.dataset.theme = this.presentation.theme;
    const root = this.host.shadowRoot!;
    const style = document.createElement('style');
    style.textContent = styles;
    const card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('role', 'status');
    const title = document.createElement('p');
    title.className = 'title';
    title.textContent =
      summary?.name ||
      magnet.displayName ||
      `${this.presentation.labels.identity} ${magnet.infoHash.slice(0, 12)}…`;
    const text = document.createElement('div');
    text.className = 'text';
    text.append(title);
    if (summary?.thumbnail?.startsWith('data:image/')) {
      card.append(compactThumbnail(summary.thumbnail, title.textContent));
    }
    const details: string[] = [];
    if (summary?.totalBytes !== undefined)
      details.push(
        `${this.presentation.labels.size}: ${formatBytes(summary.totalBytes)}`,
      );
    if (summary?.fileCount !== undefined)
      details.push(
        `${this.presentation.labels.fileCount}: ${summary.fileCount}`,
      );
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = details.join(' · ');
    if (details.length) text.append(meta);
    text.append(
      compactIdentity(magnet.infoHash, this.presentation.labels.identity),
    );
    if (status) {
      const message = document.createElement('p');
      message.className = 'status';
      message.textContent = this.presentation.labels[status];
      text.append(message);
    }
    card.append(text);
    root.replaceChildren(style, card);
    this.reposition();
  }
}
