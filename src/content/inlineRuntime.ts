import { scanMagnets, type MagnetOccurrence } from './magnetScanner';
import type { NormalizedMagnet } from '../domain/magnet';
import type { PreviewResult, PreviewState } from '../domain/preview';
import { isolatedThemeCss } from '../shared/isolatedTheme';
import { formatBytes } from '../shared/formatBytes';
import {
  compactPreviewCss,
  compactThumbnail,
  compactIdentity,
} from './compactPreview';

export type InlinePreviewSummary = Pick<
  PreviewResult,
  'name' | 'totalBytes' | 'fileCount'
>;

export interface InlinePresentation {
  theme: 'light' | 'dark';
  labels: {
    localOnly: string;
    loading: string;
    unavailable: string;
    identity: string;
    fileCount: string;
    size: string;
  };
}

export interface InlineActivation {
  type: 'inline-activate';
  presentation: InlinePresentation;
}

const marker = 'data-magnet-preview-inline';
const styles = `
  ${isolatedThemeCss}
  ${compactPreviewCss}
  :host { all: initial !important; display: block !important; box-sizing: border-box !important;
    width: min(100%, 420px) !important; max-width: 100% !important; margin: 6px 0 12px !important; }
  *, *::before, *::after { box-sizing: border-box; min-width: 0; }
  .card { color-scheme: light; font: 13px/1.5 system-ui, sans-serif; background: var(--mp-surface);
    color: var(--mp-ink); border: 1px solid var(--mp-line); border-inline-start: 3px solid var(--mp-accent);
    border-radius: 6px; padding: 12px 16px;
    overflow: hidden; display: flex; align-items: center; gap: 12px; }
  :host([data-theme="dark"]) .card { color-scheme: dark; }
`;

interface Mount {
  host: HTMLElement;
  magnet: NormalizedMagnet;
}

export class InlineRuntime {
  private mounts = new Map<string, Mount>();
  private presentation: InlinePresentation | null = null;
  private readonly results = new Map<string, InlinePreviewSummary>();
  private readonly states = new Map<string, PreviewState>();
  private readonly thumbnails = new Map<string, string>();

  activate(presentation: InlinePresentation, online = false) {
    this.presentation = presentation;
    if (!online) {
      this.results.clear();
      this.states.clear();
      this.thumbnails.clear();
    }
    const found: Array<{ key: string; node: Node; magnet: NormalizedMagnet }> =
      [];
    const indices = new WeakMap<Node, number>();
    const scan = scanMagnets(document, (occurrence: MagnetOccurrence, node) => {
      const index = indices.get(node) ?? 0;
      indices.set(node, index + 1);
      found.push({
        key: `${occurrence.source}:${occurrence.magnet.infoHash}:${index}`,
        node,
        magnet: occurrence.magnet,
      });
    });
    let skipped = 0;
    const seen = new Set<string>();
    for (const item of found) {
      const anchor =
        item.node instanceof Element ? item.node : item.node.parentElement;
      const rect = anchor?.getBoundingClientRect();
      if (
        !anchor?.isConnected ||
        !(anchor instanceof HTMLElement) ||
        !document.body?.contains(anchor) ||
        anchor === document.body ||
        !anchor.parentElement ||
        anchor.closest(`[${marker}]`) ||
        (rect &&
          (rect.right < 0 || rect.left > document.documentElement.clientWidth))
      ) {
        skipped++;
        continue;
      }
      const key = this.nodeKey(anchor, item.key);
      seen.add(key);
      let mount = this.mounts.get(key);
      if (!mount?.host.isConnected) {
        const host = document.createElement('magnet-preview-inline');
        host.setAttribute(marker, item.magnet.infoHash);
        host.attachShadow({ mode: 'open' });
        anchor.insertAdjacentElement('afterend', host);
        mount = { host, magnet: item.magnet };
        this.mounts.set(key, mount);
      }
      this.render(mount);
    }
    for (const [key, mount] of this.mounts) {
      if (seen.has(key)) continue;
      mount.host.remove();
      this.mounts.delete(key);
    }
    return {
      magnets: [
        ...new Map(
          [...this.mounts.values()].map((item) => [
            item.magnet.infoHash,
            item.magnet,
          ]),
        ).values(),
      ],
      mounted: this.mounts.size,
      skipped,
      truncated: scan.truncated,
    };
  }

  remove() {
    for (const mount of this.mounts.values()) mount.host.remove();
    this.mounts.clear();
    this.results.clear();
    this.states.clear();
    this.thumbnails.clear();
    return { removed: true };
  }

  update(
    infoHash: string,
    state?: PreviewState,
    result?: InlinePreviewSummary,
    thumbnail?: string,
  ) {
    if (state) this.states.set(infoHash, state);
    if (result) this.results.set(infoHash, result);
    if (thumbnail?.startsWith('data:image/'))
      this.thumbnails.set(infoHash, thumbnail);
    for (const mount of this.mounts.values()) {
      if (mount.magnet.infoHash === infoHash) this.render(mount);
    }
  }

  private readonly nodeIds = new WeakMap<Node, number>();
  private nextNodeId = 0;
  private nodeKey(node: Node, suffix: string) {
    let id = this.nodeIds.get(node);
    if (id === undefined) {
      id = ++this.nextNodeId;
      this.nodeIds.set(node, id);
    }
    return `${id}:${suffix}`;
  }

  private render({ host, magnet }: Mount) {
    const presentation = this.presentation;
    if (!presentation) return;
    host.dataset.theme = presentation.theme;
    const root = host.shadowRoot!;
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = styles;
    const card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('aria-label', presentation.labels.identity);
    const result = this.results.get(magnet.infoHash);
    const title = document.createElement('p');
    title.className = 'title';
    title.textContent =
      result?.name ||
      magnet.displayName ||
      `${presentation.labels.identity} ${magnet.infoHash.slice(0, 12)}…`;
    const meta = document.createElement('p');
    meta.className = 'meta';
    const details: string[] = [];
    if (result?.totalBytes !== undefined)
      details.push(
        `${presentation.labels.size}: ${formatBytes(result.totalBytes)}`,
      );
    if (result?.fileCount !== undefined)
      details.push(`${presentation.labels.fileCount}: ${result.fileCount}`);
    meta.textContent = details.join(' · ');
    const status = document.createElement('p');
    status.className = 'status';
    const phase = this.states.get(magnet.infoHash)?.phase;
    status.textContent = result
      ? ''
      : phase === 'unavailable'
        ? presentation.labels.unavailable
        : phase === 'queued' || phase === 'requesting'
          ? presentation.labels.loading
          : presentation.labels.localOnly;
    const text = document.createElement('div');
    text.className = 'text';
    text.append(title);
    if (details.length) text.append(meta);
    text.append(compactIdentity(magnet.infoHash, presentation.labels.identity));
    const thumbnail = this.thumbnails.get(magnet.infoHash);
    if (thumbnail) {
      card.append(compactThumbnail(thumbnail, title.textContent));
    }
    if (status.textContent) text.append(status);
    card.append(text);
    root.append(style, card);
  }
}
