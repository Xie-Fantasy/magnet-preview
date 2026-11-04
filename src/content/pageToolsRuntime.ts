import { isolatedThemeCss } from '../shared/isolatedTheme';
import type { PageToolLabels } from '../shared/pageToolLabels';
import type { HideScope } from '../shared/preferences/pageToolVisibility';

const styles = `
${isolatedThemeCss}
:host { all: initial !important; position: fixed !important; z-index: 2147483646 !important; display: block !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important;
  left: var(--mp-tool-x, calc(100vw - 100px)) !important; top: var(--mp-tool-y, calc(100vh - 88px)) !important;
  right: auto !important; bottom: auto !important; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.tools { position: relative; inline-size: 70px; block-size: 64px; color: var(--mp-ink); font: 13px/1.5 system-ui,sans-serif; }
button { cursor: pointer; font: inherit; color: inherit; }
.toggle, .close { display: grid; place-items: center; padding: 0; border: 1px solid var(--mp-line); border-radius: 50%;
  background: var(--mp-surface); box-shadow: 0 4px 16px #0002; }
.toggle { position: absolute; inset: auto auto 0 0; inline-size: 52px; block-size: 52px; color: var(--mp-accent);
  cursor: grab; touch-action: none; user-select: none; }
.toggle svg { inline-size: 24px; block-size: 24px; pointer-events: none; }
.toggle:hover { background: var(--mp-subtle); }
.toggle[aria-pressed="true"] { background: var(--mp-accent); color: var(--mp-contrast); }
.toggle[data-dragging="true"] { cursor: grabbing; }
.close { position: absolute; inset: 0 0 auto auto; inline-size: 24px; block-size: 24px; }
.close svg, .panel-close svg { display: block; inline-size: 14px; block-size: 14px; pointer-events: none; }
.compact { inline-size: 56px; block-size: 50px; }
.compact .toggle { inline-size: 36px; block-size: 36px; }
.compact .toggle svg { inline-size: 20px; block-size: 20px; }
.panel { position: absolute; inline-size: min(288px, calc(100vw - 24px)); max-block-size: calc(100vh - 24px);
  overflow: auto; padding: 18px; border: 1px solid var(--mp-line); border-radius: 12px;
  background: var(--mp-surface); box-shadow: 0 8px 32px #0002; color-scheme: light; }
:host([data-theme="dark"]) .panel { color-scheme: dark; }
.panel-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
h2 { margin: 0; font-size: 15px; font-weight: 600; }
.panel-close { display: grid; place-items: center; inline-size: 28px; block-size: 28px; padding: 0; border: 0; background: transparent; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0;
  border-bottom: 1px solid var(--mp-line); cursor: pointer; }
input[type="checkbox"] { appearance: none; position: relative; inline-size: 36px; block-size: 20px; flex: none; margin: 0;
  border: 1px solid transparent; border-radius: 999px; background: var(--mp-muted); }
input[type="checkbox"]::before { content: ''; position: absolute; left: 2px; top: 2px; inline-size: 14px; block-size: 14px;
  border-radius: 50%; background: var(--mp-surface); }
input[type="checkbox"]:checked { background: var(--mp-accent); }
input[type="checkbox"]:checked::before { transform: translateX(16px); }
.hide-options { margin: 10px 0 0; padding: 12px; border: 0; border-radius: 8px; background: var(--mp-subtle); min-inline-size: 0; }
.hide-choice { display: flex; align-items: center; gap: 9px; padding: 9px 0; cursor: pointer; }
input[type="radio"] { flex: none; inline-size: 16px; block-size: 16px; margin: 0; accent-color: var(--mp-accent); }
.confirm-hide { inline-size: 100%; margin-top: 12px; padding: 10px 8px; border: 0; border-radius: 6px; background: var(--mp-accent); color: var(--mp-contrast); font-weight: 600; }
.settings-link { padding: 0; border: 0; background: transparent; color: var(--mp-accent); text-decoration: underline; }
.action { display: block; inline-size: 100%; text-align: start; padding: 12px 0; border: 0; background: transparent; }
.action:hover, .panel-close:hover { color: var(--mp-accent); }
.hint, .error { margin: 12px 0 0; color: var(--mp-muted); font-size: 12px; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--mp-accent); outline-offset: 2px; }
button:disabled, input:disabled { opacity: .55; cursor: wait; }
@media (forced-colors: active) { .toggle[aria-pressed="true"] { forced-color-adjust: none;
  background: Highlight; color: HighlightText; border-color: Highlight; }
  input { appearance: auto; inline-size: 20px; block-size: 20px; } input::before { display: none; } }
`;

type Position = { x: number; y: number; compact: boolean };
export class PageToolsRuntime {
  readonly host = document.createElement('magnet-preview-tools');
  private readonly events = new AbortController();
  private position: Position;
  constructor(
    readonly token: string,
    theme: 'light' | 'dark',
    labels: PageToolLabels,
    private visible: boolean,
    openSettings: boolean,
    previous?: Position,
    private readonly onDismiss?: () => void,
  ) {
    this.position = previous ?? {
      x: innerWidth - 100,
      y: innerHeight - 88,
      compact: false,
    };
    this.host.dataset.theme = theme;
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    const tools = document.createElement('div');
    tools.className = this.position.compact ? 'tools compact' : 'tools';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', labels.title);
    const button = (name: string, className: string, text = '') => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = className;
      node.textContent = text;
      node.setAttribute('aria-label', name);
      node.title = name;
      return node;
    };
    const toggle = button(labels.show, 'toggle');
    toggle.setAttribute('aria-description', labels.drag);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      'M5 4v9a7 7 0 0 0 14 0V4M5 8h4M15 8h4M9 4v9a3 3 0 0 0 6 0V4',
    );
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.append(path);
    toggle.append(icon);
    const crossButton = (name: string, className: string) => {
      const node = button(name, className);
      const cross = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'svg',
      );
      cross.setAttribute('viewBox', '0 0 24 24');
      cross.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      path.setAttribute('d', 'M6 6L18 18M18 6L6 18');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      cross.append(path);
      node.append(cross);
      return node;
    };
    const close = crossButton(labels.settings, 'close');
    close.setAttribute('aria-haspopup', 'dialog');
    close.setAttribute('aria-controls', 'magnet-tool-settings');
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.id = 'magnet-tool-settings';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', labels.settings);
    panel.hidden = true;
    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h2');
    title.textContent = labels.settings;
    const panelClose = crossButton(labels.close, 'panel-close');
    header.append(title, panelClose);
    panel.append(header);
    const checkbox = (text: string, checked: boolean) => {
      const row = document.createElement('label');
      row.className = 'row';
      const caption = document.createElement('span');
      caption.textContent = text;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      row.append(caption, input);
      panel.append(row);
      return input;
    };
    const compact = checkbox(labels.compact, this.position.compact);
    const inline = checkbox(labels.inline, this.visible);
    const my = button(labels.my, 'action', labels.my);
    const dismiss = checkbox(labels.dismiss, false);
    dismiss.setAttribute('aria-expanded', 'false');
    dismiss.setAttribute('aria-controls', 'magnet-tool-hide-options');
    const hideOptions = document.createElement('fieldset');
    hideOptions.className = 'hide-options';
    hideOptions.id = 'magnet-tool-hide-options';
    hideOptions.setAttribute('aria-label', labels.dismiss);
    hideOptions.hidden = true;
    let hideScope: HideScope = 'visit';
    for (const [scope, text] of [
      ['visit', labels.hideVisit],
      ['global', labels.hideGlobal],
      ['site', labels.hideSite],
    ] as const) {
      const row = document.createElement('label');
      row.className = 'hide-choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'magnet-tool-hide-scope';
      radio.value = scope;
      radio.checked = scope === hideScope;
      radio.addEventListener(
        'change',
        () => {
          hideScope = scope;
        },
        { signal: this.events.signal },
      );
      const textNode = document.createElement('span');
      textNode.textContent = text;
      row.append(radio, textNode);
      hideOptions.append(row);
    }
    const restoreHelp = document.createElement('p');
    restoreHelp.className = 'hint';
    restoreHelp.textContent = `${labels.restoreHelp} `;
    const settingsLink = button(
      labels.settingsLink,
      'settings-link',
      labels.settingsLink,
    );
    restoreHelp.append(settingsLink);
    const confirmHide = button(
      labels.confirmHide,
      'confirm-hide',
      labels.confirmHide,
    );
    hideOptions.append(restoreHelp, confirmHide);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = labels.drag;
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    panel.append(hideOptions, my, hint, error);
    tools.append(toggle, close, panel);
    root.append(style, tools);
    document.body.append(this.host);
    const placePanel = () => {
      if (panel.hidden) return;
      const bounds = this.host.getBoundingClientRect();
      const { width, height } = panel.getBoundingClientRect();
      const left = Math.max(12, Math.min(bounds.left, innerWidth - width - 12));
      const preferred =
        bounds.top - height - 12 >= 12
          ? bounds.top - height - 12
          : bounds.bottom + 12;
      const top = Math.max(12, Math.min(preferred, innerHeight - height - 12));
      panel.style.left = `${left - bounds.left}px`;
      panel.style.top = `${top - bounds.top}px`;
    };
    const move = (x: number, y: number) => {
      this.position.x = Math.max(
        12,
        Math.min(x, innerWidth - tools.offsetWidth - 12),
      );
      this.position.y = Math.max(
        12,
        Math.min(y, innerHeight - tools.offsetHeight - 12),
      );
      this.host.style.setProperty(
        '--mp-tool-x',
        `${this.position.x}px`,
        'important',
      );
      this.host.style.setProperty(
        '--mp-tool-y',
        `${this.position.y}px`,
        'important',
      );
      placePanel();
    };
    const showPanel = (show: boolean, restoreFocus = true) => {
      panel.hidden = !show;
      close.setAttribute('aria-expanded', String(show));
      if (show) {
        placePanel();
        panelClose.focus({ preventScroll: true });
      } else if (restoreFocus) close.focus({ preventScroll: true });
    };
    const update = () => {
      const name = this.visible ? labels.hide : labels.show;
      toggle.setAttribute('aria-label', name);
      toggle.title = name;
      toggle.setAttribute('aria-pressed', String(this.visible));
      inline.checked = this.visible;
    };
    const perform = async (type: string) => {
      const closing = type === 'page-tools-dismiss';
      if (closing && confirmHide.disabled) return;
      if (closing) confirmHide.disabled = true;
      toggle.disabled = inline.disabled = my.disabled = true;
      error.hidden = true;
      try {
        const result = (await chrome.runtime.sendMessage({
          type,
          token: this.token,
          ...(closing ? { scope: hideScope } : {}),
        })) as { kind?: string };
        if (result?.kind === 'shown' || result?.kind === 'hidden')
          this.visible = result.kind === 'shown';
        else if (result?.kind === 'closed') {
          this.dispose();
          this.onDismiss?.();
        } else if (result?.kind !== 'opened') throw new Error('unavailable');
      } catch {
        error.textContent = labels.error;
        error.hidden = false;
        showPanel(true);
      } finally {
        update();
        toggle.disabled = inline.disabled = my.disabled = false;
        if (closing) confirmHide.disabled = false;
      }
    };
    const options = { signal: this.events.signal };
    compact.addEventListener(
      'change',
      () => {
        this.position.compact = compact.checked;
        tools.classList.toggle('compact', compact.checked);
        move(this.position.x, this.position.y);
      },
      options,
    );
    inline.addEventListener(
      'change',
      () => void perform('page-tools-inline-toggle'),
      options,
    );
    my.addEventListener(
      'click',
      () => void perform('page-tools-open-my'),
      options,
    );
    dismiss.addEventListener(
      'change',
      () => {
        hideOptions.hidden = !dismiss.checked;
        dismiss.setAttribute('aria-expanded', String(dismiss.checked));
        placePanel();
      },
      options,
    );
    settingsLink.addEventListener(
      'click',
      () => void perform('page-tools-open-settings'),
      options,
    );
    confirmHide.addEventListener(
      'click',
      () => void perform('page-tools-dismiss'),
      options,
    );
    close.addEventListener('click', () => showPanel(true), options);
    panelClose.addEventListener('click', () => showPanel(false), options);
    root.addEventListener(
      'keydown',
      (event) => {
        if ((event as KeyboardEvent).key === 'Escape' && !panel.hidden) {
          event.preventDefault();
          showPanel(false);
        }
      },
      options,
    );
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!panel.hidden && !event.composedPath().includes(this.host))
          showPanel(false, false);
      },
      options,
    );
    let drag: {
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
      moved: boolean;
    } | null = null;
    let suppressClick = false;
    toggle.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: this.position.x,
          top: this.position.y,
          moved: false,
        };
        suppressClick = false;
        toggle.setPointerCapture(event.pointerId);
      },
      options,
    );
    toggle.addEventListener(
      'pointermove',
      (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        toggle.dataset.dragging = 'true';
        showPanel(false, false);
        move(drag.left + dx, drag.top + dy);
      },
      options,
    );
    const endDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      suppressClick = event.type === 'pointerup' && drag.moved;
      drag = null;
      delete toggle.dataset.dragging;
      if (toggle.hasPointerCapture(event.pointerId))
        toggle.releasePointerCapture(event.pointerId);
    };
    toggle.addEventListener('pointerup', endDrag, options);
    toggle.addEventListener('pointercancel', endDrag, options);
    toggle.addEventListener(
      'click',
      (event) => {
        if (suppressClick && event.detail !== 0) {
          suppressClick = false;
          return;
        }
        suppressClick = false;
        void perform('page-tools-inline-toggle');
      },
      options,
    );
    toggle.addEventListener(
      'keydown',
      (event) => {
        const delta = event.shiftKey ? 32 : 12;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-delta, 0],
          ArrowRight: [delta, 0],
          ArrowUp: [0, -delta],
          ArrowDown: [0, delta],
        };
        const step = moves[event.key];
        if (!step) return;
        event.preventDefault();
        move(this.position.x + step[0], this.position.y + step[1]);
      },
      options,
    );
    window.addEventListener(
      'resize',
      () => move(this.position.x, this.position.y),
      options,
    );
    move(this.position.x, this.position.y);
    update();
    showPanel(openSettings, false);
  }
  snapshot() {
    return { ...this.position };
  }
  isActive(token: string) {
    return this.host.isConnected && token === this.token;
  }
  dispose() {
    this.events.abort();
    this.host.remove();
  }
}
