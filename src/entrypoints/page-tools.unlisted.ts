import { PageToolsRuntime } from '../content/pageToolsRuntime';
import { pageToolLabels, type PageToolLabels } from '../shared/pageToolLabels';

declare global {
  var __magnetPreviewPageTools: PageToolsRuntime | undefined;
  var __magnetPreviewPageToolsInstalled: boolean | undefined;
}
export default defineUnlistedScript(() => {
  if (globalThis.__magnetPreviewPageToolsInstalled) return;
  globalThis.__magnetPreviewPageToolsInstalled = true;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    if (!message || typeof message !== 'object') return;
    const input = message as Record<string, unknown>;
    if (input.type === 'page-tools-close') {
      globalThis.__magnetPreviewPageTools?.dispose();
      globalThis.__magnetPreviewPageTools = undefined;
      respond({ kind: 'closed' });
      return;
    }
    if (input.type === 'page-tools-status') {
      respond({
        active:
          globalThis.__magnetPreviewPageTools?.isActive(
            String(input.token ?? ''),
          ) === true,
      });
      return;
    }
    if (input.type !== 'page-tools-open') return;
    const labels = input.labels as PageToolLabels | undefined;
    if (
      typeof input.token !== 'string' ||
      !labels ||
      Object.keys(pageToolLabels((key) => key)).some(
        (key) => typeof labels[key as keyof PageToolLabels] !== 'string',
      )
    )
      return;
    const previous = globalThis.__magnetPreviewPageTools;
    const position = previous?.snapshot();
    previous?.dispose();
    const runtime = new PageToolsRuntime(
      input.token,
      input.theme === 'dark' ? 'dark' : 'light',
      labels,
      input.visible === true,
      input.openSettings === true,
      position,
      () => {
        if (globalThis.__magnetPreviewPageTools === runtime)
          globalThis.__magnetPreviewPageTools = undefined;
      },
    );
    globalThis.__magnetPreviewPageTools = runtime;
    respond({ kind: 'ready' });
  });
});
