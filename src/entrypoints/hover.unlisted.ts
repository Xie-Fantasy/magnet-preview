import { HoverRuntime, type HoverPresentation } from '../content/hoverRuntime';

declare global {
  var __magnetPreviewHover: HoverRuntime | undefined;
}

export default defineUnlistedScript(() => {
  if (globalThis.__magnetPreviewHover) return;
  const runtime = new HoverRuntime(async (infoHash, token) => {
    const response = await chrome.runtime.sendMessage({
      type: 'hover-preview',
      infoHash,
      token,
    });
    return response?.kind === 'success' ? response.summary : null;
  });
  globalThis.__magnetPreviewHover = runtime;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    if (!message || typeof message !== 'object') return;
    const input = message as Record<string, unknown>;
    if (input.type === 'hover-activate')
      respond(
        runtime.activate(
          input.token as string,
          input.presentation as HoverPresentation,
          input.online === true,
        ),
      );
    else if (input.type === 'hover-remove') respond(runtime.remove());
    else if (input.type === 'hover-status')
      respond({ active: runtime.isActive(String(input.token ?? '')) });
  });
});
