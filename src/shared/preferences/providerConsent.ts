const key = 'magnetPreview.providerConsent.v1';
export const PROVIDER_CONSENT_VERSION = 1;

export function getProviderConsent(): boolean | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const input = value as Record<string, unknown>;
    if (
      input.version !== PROVIDER_CONSENT_VERSION ||
      typeof input.enabled !== 'boolean'
    )
      return null;
    return input.enabled;
  } catch {
    return null;
  }
}

export function hasProviderConsent(): boolean {
  return getProviderConsent() === true;
}

export function setProviderConsent(enabled: boolean): void {
  localStorage.setItem(
    key,
    JSON.stringify({ version: PROVIDER_CONSENT_VERSION, enabled }),
  );
  window.dispatchEvent(new Event('magnet-preview-provider-consent'));
  if (typeof chrome !== 'undefined' && chrome.storage?.local)
    void chrome.storage.local.set({
      'magnetPreview.providerConsentMirror.v1': enabled,
    });
  if (
    !enabled &&
    typeof chrome !== 'undefined' &&
    chrome.runtime?.sendMessage
  ) {
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: 'hover-revoke-all' }),
    ).catch(() => undefined);
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: 'page-tools-revoke-all' }),
    ).catch(() => undefined);
  }
}
