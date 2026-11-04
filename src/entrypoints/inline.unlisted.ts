import {
  InlineRuntime,
  type InlineActivation,
  type InlinePreviewSummary,
} from '../content/inlineRuntime';
import type { PreviewState } from '../domain/preview';

declare global {
  var __magnetPreviewInline: InlineRuntime | undefined;
}

export default defineUnlistedScript(() => {
  if (globalThis.__magnetPreviewInline) return;
  const runtime = new InlineRuntime();
  globalThis.__magnetPreviewInline = runtime;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    if (!message || typeof message !== 'object') return;
    const input = message as Record<string, unknown>;
    if (input.type === 'inline-activate') {
      respond(
        runtime.activate(
          (input as unknown as InlineActivation).presentation,
          input.online === true,
        ),
      );
    } else if (input.type === 'inline-remove') {
      respond(runtime.remove());
    } else if (
      input.type === 'inline-update' &&
      typeof input.infoHash === 'string'
    ) {
      runtime.update(
        input.infoHash,
        input.state as PreviewState | undefined,
        input.result as InlinePreviewSummary | undefined,
        input.thumbnail as string | undefined,
      );
    }
  });
});
