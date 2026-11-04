// Presentation shared by the two read-only, Shadow DOM page previews.
export const compactPreviewCss = `
  .text { flex: 1; min-width: 0; }
  .title { font-weight: 600; overflow-wrap: anywhere; word-break: break-word; margin: 0 0 4px; }
  .meta, .status { margin: 0; color: var(--mp-muted); font-size: 12px; overflow-wrap: anywhere; }
  .identity { display: block; margin-top: 4px; color: var(--mp-muted); font: 11px/1.5 ui-monospace,Consolas,monospace; overflow-wrap: anywhere; }
  .status { margin-top: 6px; }
  .media { position: relative; display: grid; place-items: center; flex: 0 0 64px; inline-size: 64px; block-size: 48px;
    overflow: hidden; border-radius: 6px; background: var(--mp-subtle); color: var(--mp-muted); }
  .media svg { inline-size: 20px; block-size: 20px; }
  .thumb { position: absolute; inset: 0; display: block; inline-size: 100%; block-size: 100%; object-fit: cover; }
`;

export function compactThumbnail(source: string, label: string): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'media';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 5h18v14H3V5ZM5 17l5-4 3 2 3-3 3 3M9 9h.01');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  icon.append(path);
  frame.append(icon);
  if (source.startsWith('data:image/')) {
    const image = document.createElement('img');
    image.className = 'thumb';
    image.alt = label;
    image.src = source;
    image.addEventListener('error', () => image.remove(), { once: true });
    frame.append(image);
  }
  return frame;
}

export function compactIdentity(hash: string, label: string): HTMLElement {
  const identity = document.createElement('code');
  identity.className = 'identity';
  identity.setAttribute('aria-label', label);
  identity.title = hash;
  identity.textContent = `${hash.slice(0, 12)}…`;
  return identity;
}
