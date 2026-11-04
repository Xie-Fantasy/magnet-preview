const key = 'magnetPreview.hover.v1';

export function getHoverEnabled(): boolean {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Boolean(
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).version === 1 &&
      (value as Record<string, unknown>).enabled === true,
    );
  } catch {
    return false;
  }
}

export function setHoverEnabled(enabled: boolean): void {
  localStorage.setItem(key, JSON.stringify({ version: 1, enabled }));
  window.dispatchEvent(new Event('magnet-preview-hover-setting'));
  if (!enabled && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: 'hover-revoke-all' }),
    ).catch(() => undefined);
}
