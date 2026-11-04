import { scanMagnets } from '../content/magnetScanner';

export default defineUnlistedScript(() => {
  Object.assign(globalThis, {
    __magnetPreviewScan: () => scanMagnets(document),
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'scan-current-document') return;
    sendResponse(scanMagnets(document));
  });
});
