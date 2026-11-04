export default defineUnlistedScript(() => {
  if (window.top !== window) return;
  void chrome.runtime
    .sendMessage({
      type: 'page-tools-auto-open',
      systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
    })
    .catch(() => undefined);
});
