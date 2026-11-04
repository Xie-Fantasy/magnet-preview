import type { FavoriteRecord, FavoriteStore } from './favorites';
import { formatBytes } from '../shared/formatBytes';

const MAX_ITEMS = 1_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_HTML_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

interface ExportItem {
  infoHash: string;
  magnet: string;
  snapshot: ExportSnapshot | null;
  createdAt: number;
  updatedAt: number;
  assets: string[];
  missingImageCount: number;
}

interface ExportSnapshot {
  name?: string;
  totalBytes?: number;
  fileCount?: number;
  files?: { path: string; bytes?: number }[];
  screenshots: { id: string }[];
  fetchedAt: number;
}

interface ExportData {
  schemaVersion: 1;
  exportedAt: string;
  items: ExportItem[];
}

interface Collected {
  data: ExportData;
  assets: Map<string, Uint8Array<ArrayBuffer>>;
  types: Map<string, string>;
}

export type ExportFormat = 'html' | 'zip' | 'json';
export type ExportLocale = 'en' | 'zh_CN';

const COPY = {
  en: {
    lang: 'en',
    title: 'Magnet Preview Favorites',
    hash: 'InfoHash',
    magnet: 'Magnet',
    image: 'Preview image',
    previous: 'Previous screenshot',
    next: 'Next screenshot',
    size: 'Size',
    files: 'File count',
    fileList: 'Files',
    theme: 'Color mode',
    themeDark: 'Switch to dark mode',
    themeLight: 'Switch to light mode',
    search: 'Search titles',
    navigation: 'Favorites',
    defaultExpanded: 'Expand by default',
    expand: 'Expand',
    collapse: 'Collapse',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    copy: 'Copy Magnet',
    copied: 'Magnet copied',
    copyFailed: 'Copy failed',
    noMatches: 'No matching titles.',
    missing: 'No local preview image is available for some screenshots.',
    readme:
      'Magnet Preview favorites export\n\nOpen index.html in a browser to browse the collection offline. Keep the collection folder together; images are in assets/. data.json uses schemaVersion 1. Import/Restore is not supported in V1.\n',
  },
  zh_CN: {
    lang: 'zh-CN',
    title: 'Magnet Preview 收藏',
    hash: 'InfoHash',
    magnet: 'Magnet',
    image: '预览图片',
    previous: '上一张截图',
    next: '下一张截图',
    size: '大小',
    files: '文件数',
    fileList: '文件',
    theme: '颜色模式',
    themeDark: '切换到深色模式',
    themeLight: '切换到浅色模式',
    search: '按标题搜索',
    navigation: '收藏导航',
    defaultExpanded: '默认展开',
    expand: '展开',
    collapse: '折叠',
    expandAll: '全部展开',
    collapseAll: '全部折叠',
    copy: '复制磁力链接',
    copied: '已复制磁力链接',
    copyFailed: '复制失败',
    noMatches: '没有匹配的标题。',
    missing: '部分截图没有本地预览图片。',
    readme:
      'Magnet Preview 收藏导出\n\n在浏览器中打开 index.html 即可离线浏览。请保持 collection 文件夹完整；图片位于 assets/。data.json 使用 schemaVersion 1。V1 不支持导入或恢复。\n',
  },
} as const;

export async function exportFavorites(
  store: FavoriteStore,
  format: ExportFormat,
  now: () => Date = () => new Date(),
  locale: ExportLocale = 'en',
): Promise<Blob> {
  const collected = await collect(store, format, now);
  if (format === 'html') {
    const html = await renderHtml(collected, locale);
    if (new TextEncoder().encode(html).length > MAX_HTML_BYTES)
      throw new Error('html_too_large');
    return new Blob([html], { type: 'text/html;charset=utf-8' });
  }
  if (format === 'json') {
    const assets = Object.fromEntries(
      [...collected.assets].map(([path, bytes]) => [path, toBase64(bytes)]),
    );
    const json = JSON.stringify({ ...collected.data, assets }, null, 2);
    if (new TextEncoder().encode(json).length > MAX_JSON_BYTES)
      throw new Error('json_too_large');
    return new Blob([json], {
      type: 'application/json;charset=utf-8',
    });
  }
  const { zip, strToU8 } = await import('fflate');
  const files: Record<string, Uint8Array<ArrayBuffer>> = {
    'collection/index.html': strToU8(await renderHtml(collected, locale, true)),
    'collection/data.json': strToU8(JSON.stringify(collected.data, null, 2)),
    'collection/README.txt': strToU8(COPY[locale].readme),
  };
  for (const [path, bytes] of collected.assets)
    files['collection/' + path] = bytes;
  const packed = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) =>
    zip(files, { level: 0 }, (error, output) =>
      error ? reject(error) : resolve(output),
    ),
  );
  if (packed.byteLength > MAX_PACKAGE_BYTES + 4 * 1024 * 1024)
    throw new Error('export_too_large');
  return new Blob([packed], { type: 'application/zip' });
}

async function collect(
  store: FavoriteStore,
  format: ExportFormat,
  now: () => Date,
): Promise<Collected> {
  const records = await store.list();
  if (records.length > MAX_ITEMS) throw new Error('too_many_favorites');
  if (records.length === 0) throw new Error('empty_favorites');
  const assets = new Map<string, Uint8Array<ArrayBuffer>>();
  const types = new Map<string, string>();
  const items: ExportItem[] = [];
  let totalBytes = 0;
  let encodedAssetBytes = 0;
  let metadataBytes = 0;
  const encoder = new TextEncoder();
  for (const record of records) {
    if (
      !/^[A-F0-9]{40}$/.test(record.infoHash) ||
      record.assetIds.length > 8 ||
      new Set(record.assetIds).size !== record.assetIds.length
    )
      throw new Error('invalid_favorite');
    metadataBytes += encoder.encode(record.magnet).length;
    metadataBytes += encoder.encode(record.snapshot?.name ?? '').length;
    for (const file of record.snapshot?.files ?? [])
      metadataBytes += encoder.encode(file.path).length;
    if (
      metadataBytes + (format === 'zip' ? totalBytes : encodedAssetBytes) >
      (format === 'html'
        ? MAX_HTML_BYTES
        : format === 'json'
          ? MAX_JSON_BYTES
          : MAX_PACKAGE_BYTES + 4 * 1024 * 1024)
    )
      throw new Error(
        format === 'html'
          ? 'html_too_large'
          : format === 'json'
            ? 'json_too_large'
            : 'export_too_large',
      );
    const paths: string[] = [];
    for (const imageId of record.assetIds) {
      if (!/^[0-9]{1,2}$/.test(imageId)) throw new Error('invalid_favorite');
      const blob = await store.getAsset(record.infoHash, imageId);
      if (!blob) continue;
      const extension = EXTENSIONS[blob.type];
      if (!extension || blob.size === 0) throw new Error('invalid_asset');
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('export_too_large');
      totalBytes += blob.size;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error('export_too_large');
      encodedAssetBytes += Math.ceil(blob.size / 3) * 4;
      if (
        format === 'html' &&
        encodedAssetBytes + metadataBytes > MAX_HTML_BYTES
      )
        throw new Error('html_too_large');
      if (
        format === 'json' &&
        encodedAssetBytes + metadataBytes > MAX_JSON_BYTES
      )
        throw new Error('json_too_large');
      const path = `assets/${record.infoHash}/${imageId}.${extension}`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      assets.set(path, bytes);
      types.set(path, blob.type);
      paths.push(path);
    }
    items.push({
      infoHash: record.infoHash,
      magnet: record.magnet,
      snapshot: exportSnapshot(record.snapshot),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      assets: paths,
      missingImageCount:
        record.missingImageCount + record.assetIds.length - paths.length,
    });
  }
  return {
    data: { schemaVersion: 1, exportedAt: now().toISOString(), items },
    assets,
    types,
  };
}

function exportSnapshot(
  snapshot: FavoriteRecord['snapshot'],
): ExportSnapshot | null {
  if (!snapshot) return null;
  return {
    name: snapshot.name,
    totalBytes: snapshot.totalBytes,
    fileCount: snapshot.fileCount,
    files: snapshot.files?.map((file) => ({
      path: file.path,
      bytes: file.bytes,
    })),
    screenshots: snapshot.screenshots.map((image) => ({ id: image.id })),
    fetchedAt: snapshot.fetchedAt,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}

function toBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(output);
}

function displayTitle(item: ExportItem): string {
  if (item.snapshot?.name) return item.snapshot.name;
  try {
    return new URL(item.magnet).searchParams.get('dn') || item.infoHash;
  } catch {
    return item.infoHash;
  }
}

async function renderHtml(
  collected: Collected,
  locale: ExportLocale,
  linkedAssets = false,
): Promise<string> {
  const copy = COPY[locale];
  const cards = collected.data.items
    .map((item) => {
      const title = displayTitle(item);
      const images = item.assets
        .map((path, index) => {
          const source = linkedAssets
            ? path
            : `data:${collected.types.get(path)};base64,${toBase64(collected.assets.get(path)!)}`;
          return `<img src="${escapeHtml(source)}" alt="${escapeHtml(copy.image)} ${index + 1}" loading="lazy">`;
        })
        .join('');
      const thumbnail = item.assets[0]
        ? `<img class="thumbnail" src="${escapeHtml(linkedAssets ? item.assets[0] : `data:${collected.types.get(item.assets[0])};base64,${toBase64(collected.assets.get(item.assets[0])!)}`)}" alt="${escapeHtml(copy.image)}" loading="lazy">`
        : '';
      const gallery = images
        ? `<div class="image-browser"><div class="gallery-controls"><span class="gallery-count"></span>${item.assets.length > 1 ? `<button type="button" data-gallery-step="-1" aria-label="${escapeHtml(copy.previous)}" title="${escapeHtml(copy.previous)}" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><button type="button" data-gallery-step="1" aria-label="${escapeHtml(copy.next)}" title="${escapeHtml(copy.next)}" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button>` : ''}</div><div class="gallery" role="group" aria-label="${escapeHtml(copy.image)}" tabindex="0">${images}</div></div>`
        : '';
      const metadata = [
        item.snapshot?.totalBytes === undefined
          ? ''
          : `<p>${copy.size}: ${formatBytes(item.snapshot.totalBytes)} (${item.snapshot.totalBytes.toLocaleString()} B)</p>`,
        item.snapshot?.fileCount === undefined
          ? ''
          : `<p>${copy.files}: ${item.snapshot.fileCount}</p>`,
      ].join('');
      const files = item.snapshot?.files?.length
        ? `<details><summary>${escapeHtml(copy.fileList)}</summary><ul>${item.snapshot.files.map((file) => `<li>${escapeHtml(file.path)}${file.bytes === undefined ? '' : ` (${formatBytes(file.bytes)})`}</li>`).join('')}</ul></details>`
        : '';
      return `<article id="favorite-${item.infoHash}" data-title="${escapeHtml(title.toLocaleLowerCase())}" data-expanded="false"><div class="summary">${thumbnail}<div class="summary-text"><h2>${escapeHtml(title)}</h2><p class="muted">${item.snapshot?.totalBytes === undefined ? '' : `${copy.size}: ${formatBytes(item.snapshot.totalBytes)} · `}${item.snapshot?.fileCount === undefined ? '' : `${copy.files}: ${item.snapshot.fileCount} · `}${escapeHtml(item.infoHash.slice(0, 12))}…</p><div class="actions"><button type="button" data-toggle aria-expanded="false" aria-controls="details-${item.infoHash}">${escapeHtml(copy.expand)}</button><button type="button" data-copy="${escapeHtml(item.magnet)}">${escapeHtml(copy.copy)}</button></div></div></div><div class="details" id="details-${item.infoHash}" hidden><p>${escapeHtml(copy.hash)}: <code>${escapeHtml(item.infoHash)}</code></p>${metadata}${gallery}${files}<p>${escapeHtml(copy.magnet)}: <code>${escapeHtml(item.magnet)}</code></p>${item.missingImageCount > 0 ? `<p>${escapeHtml(copy.missing)}</p>` : ''}</div></article>`;
    })
    .join('');
  const navigation = collected.data.items
    .map(
      (item) =>
        `<a href="#favorite-${item.infoHash}" data-nav="${item.infoHash}">${escapeHtml(displayTitle(item))}</a>`,
    )
    .join('');
  const script = `(() => {
    const search = document.getElementById('search');
    const cards = [...document.querySelectorAll('article[data-title]')];
    const preference = document.getElementById('default-expanded');
    const message = document.getElementById('message');
    const galleries = [...document.querySelectorAll('.image-browser')].map((browser) => {
      const strip = browser.querySelector('.gallery');
      const images = [...strip.children];
      const previous = browser.querySelector('[data-gallery-step="-1"]');
      const next = browser.querySelector('[data-gallery-step="1"]');
      let current = 0;
      let overflow = false;
      const update = () => {
        const maximum = strip.scrollWidth - strip.clientWidth;
        overflow = maximum > 1;
        const start = images[0].offsetLeft;
        current = overflow && strip.scrollLeft >= maximum - 1 ? images.length - 1 : images.reduce((nearest, image, index) => Math.abs(image.offsetLeft - start - strip.scrollLeft) < Math.abs(images[nearest].offsetLeft - start - strip.scrollLeft) ? index : nearest, 0);
        browser.querySelector('.gallery-count').textContent = overflow ? (current + 1) + ' / ' + images.length : String(images.length);
        if (previous) previous.disabled = !overflow || current === 0;
        if (next) next.disabled = !overflow || current === images.length - 1;
      };
      const go = (index) => {
        const image = images[Math.max(0, Math.min(index, images.length - 1))];
        strip.scrollTo({ left: image.offsetLeft - images[0].offsetLeft, behavior: 'instant' });
      };
      if (previous) previous.addEventListener('click', () => go(current - 1));
      if (next) next.addEventListener('click', () => go(current + 1));
      strip.addEventListener('scroll', update, { passive: true });
      strip.addEventListener('keydown', (event) => {
        if (event.target !== strip || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !overflow) return;
        const index = event.key === 'ArrowLeft' ? current - 1 : event.key === 'ArrowRight' ? current + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? images.length - 1 : undefined;
        if (index !== undefined) { event.preventDefault(); go(index); }
      });
      window.addEventListener('resize', update);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(strip);
      update();
      return { browser, update };
    });
    const setOpen = (card, open) => {
      card.dataset.expanded = String(open);
      card.querySelector('.details').hidden = !open;
      const button = card.querySelector('[data-toggle]');
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? ${JSON.stringify(copy.collapse)} : ${JSON.stringify(copy.expand)};
      if (open) galleries.filter(({ browser }) => card.contains(browser)).forEach(({ update }) => update());
    };
    try { preference.checked = localStorage.getItem('magnet-preview-export-expanded-default.v1') === 'true'; } catch {}
    cards.forEach((card) => setOpen(card, preference.checked));
    preference.addEventListener('change', () => {
      try { localStorage.setItem('magnet-preview-export-expanded-default.v1', String(preference.checked)); } catch {}
      cards.forEach((card) => setOpen(card, preference.checked));
    });
    search.addEventListener('input', () => {
      const term = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      cards.forEach((card) => {
        card.hidden = !card.dataset.title.includes(term);
        if (!card.hidden) visible++;
        const nav = document.querySelector('[data-nav="' + card.id.slice(9) + '"]');
        if (nav) nav.hidden = card.hidden;
      });
      document.getElementById('no-matches').hidden = visible > 0;
    });
    document.getElementById('expand-all').addEventListener('click', () => cards.filter((card) => !card.hidden).forEach((card) => setOpen(card, true)));
    document.getElementById('collapse-all').addEventListener('click', () => cards.filter((card) => !card.hidden).forEach((card) => setOpen(card, false)));
    document.addEventListener('click', async (event) => {
      const toggle = event.target.closest('[data-toggle]');
      if (toggle) setOpen(toggle.closest('article'), toggle.getAttribute('aria-expanded') !== 'true');
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      const value = button.dataset.copy;
      let copied = false;
      try { await navigator.clipboard.writeText(value); copied = true; } catch {
        const field = document.createElement('textarea');
        field.value = value; field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.append(field); field.select();
        try { copied = document.execCommand('copy'); } catch {}
        field.remove();
      }
      message.textContent = copied ? ${JSON.stringify(copy.copied)} : ${JSON.stringify(copy.copyFailed)};
    });
  })();`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(script),
  );
  const scriptHash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return `<!doctype html><html lang="${copy.lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'"><title>${escapeHtml(copy.title)}</title><style>
body{margin:0;font:14px/1.6 system-ui,sans-serif}*{box-sizing:border-box;min-width:0}
[hidden]{display:none!important}
#dark-mode{position:absolute;inline-size:1px;block-size:1px;opacity:0}
.document{min-height:100vh;background:#f7f8f7;color:#202824;--card:#fff;--subtle:#f5f7f5;--line:#e3e8e4;--muted:#626c65;--link:#216641}
#dark-mode:checked~.document{background:#141715;color:#edf1ee;--card:#1d211f;--subtle:#232825;--line:#303833;--muted:#a7b0aa;--link:#9cd5ae;color-scheme:dark}
.content{max-width:1200px;margin:auto;padding:2rem 2.5rem 3rem}h1{font-size:24px;font-weight:600;letter-spacing:-.03em;margin:1.5rem 0 2rem}.theme-toggle{float:right;font-size:12px}button:hover,.theme-toggle:hover{background:var(--subtle);color:var(--link)}input[type=checkbox]{accent-color:var(--link)}
.theme-toggle,button{display:inline-block;padding:.4rem .7rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:inherit;font:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
aside :is(input,a):focus-visible{outline-offset:-2px}
#dark-mode:focus-visible~.document .theme-toggle{outline:2px solid var(--link);outline-offset:3px}
.theme-light{display:none}#dark-mode:checked~.document .theme-dark{display:none}#dark-mode:checked~.document .theme-light{display:inline}
.layout{display:grid;grid-template-columns:minmax(180px,220px) minmax(0,1fr);gap:2rem;align-items:start}
aside{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto;border-right:1px solid var(--line);padding:0 1.5rem 0 0;font-size:12px}
aside nav{display:grid;gap:.4rem;margin-top:.75rem}aside a{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);padding:.5rem .7rem;border-radius:6px;text-decoration:none}aside a:hover{background:var(--subtle);color:var(--link)}
input[type=search]{width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:inherit;font:inherit}
.controls,.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}.controls{margin-bottom:1rem;font-size:12px}.controls label{display:inline-flex;align-items:center;gap:.5rem;min-height:28px;margin-right:auto}
article{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.4rem;margin:0 0 .75rem;overflow-wrap:anywhere;scroll-margin-top:1rem}
article:target{border-color:var(--link)}
.summary{display:flex;gap:1.4rem;align-items:flex-start}.summary-text{min-width:0;flex:1}.thumbnail{width:120px;height:80px;flex:none;object-fit:cover;border-radius:8px}
h1,h2{line-height:1.3}h2{font-size:1.05rem;margin:0 0 .35rem}code{overflow-wrap:anywhere}.muted{color:var(--muted);margin:.25rem 0}.actions{margin-top:.75rem;font-size:12px}.actions button{border-color:transparent;background:transparent;color:var(--muted)}.actions button:first-child{color:var(--link)}
.details{margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--line)}.gallery{display:flex;gap:.75rem;overflow-x:auto;scroll-snap-type:x mandatory;padding:.5rem 0 1rem}
.gallery img{display:block;flex:0 0 min(100%,600px);inline-size:min(100%,600px);block-size:340px;object-fit:contain;scroll-snap-align:start;border-radius:8px}
.gallery-controls{display:flex;align-items:center;justify-content:flex-end;gap:4px}.gallery-count{min-width:34px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted)}.gallery-controls button{display:grid;place-items:center;width:24px;height:24px;padding:0;background:transparent;border-color:transparent}.gallery-controls svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.gallery-controls button:disabled{opacity:.4;cursor:default}
@media(max-width:680px){.content{padding:1rem}.layout{grid-template-columns:1fr}aside{position:static;max-height:160px;border:0;padding:0}aside nav{display:none}.thumbnail{width:88px;height:66px}.gallery img{block-size:240px}}
</style><input id="dark-mode" type="checkbox" aria-label="${escapeHtml(copy.theme)}"><main class="document"><div class="content"><label class="theme-toggle" for="dark-mode"><span class="theme-dark">${escapeHtml(copy.themeDark)}</span><span class="theme-light">${escapeHtml(copy.themeLight)}</span></label><h1>${escapeHtml(copy.title)}</h1><div class="layout"><aside aria-label="${escapeHtml(copy.navigation)}"><label for="search">${escapeHtml(copy.search)}</label><input id="search" type="search" placeholder="${escapeHtml(copy.search)}"><nav>${navigation}</nav></aside><div><div class="controls"><label><input id="default-expanded" type="checkbox"> ${escapeHtml(copy.defaultExpanded)}</label><button id="expand-all" type="button">${escapeHtml(copy.expandAll)}</button><button id="collapse-all" type="button">${escapeHtml(copy.collapseAll)}</button></div><p id="message" role="status" aria-live="polite"></p><p id="no-matches" hidden>${escapeHtml(copy.noMatches)}</p>${cards}</div></div></div></main><script>${script}</script></html>`;
}
