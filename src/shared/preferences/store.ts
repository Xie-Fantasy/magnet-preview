import {
  defaultTheme,
  parseThemePreference,
  type ThemePreference,
} from './theme';

const key = 'magnetPreview.preferences.v1';
export type LanguagePreference = 'browser' | 'en' | 'zh_CN';
export interface Preferences {
  schemaVersion: 1;
  theme: ThemePreference;
  language: LanguagePreference;
}
export const defaults: Preferences = {
  schemaVersion: 1,
  theme: defaultTheme,
  language: 'browser',
};

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return defaults;
    const input = value as Record<string, unknown>;
    if (input.schemaVersion !== 1) return defaults;
    return {
      schemaVersion: 1,
      theme: parseThemePreference(input.theme),
      language: ['browser', 'en', 'zh_CN'].includes(String(input.language))
        ? (input.language as LanguagePreference)
        : 'browser',
    };
  } catch {
    return defaults;
  }
}

export function savePreferences(value: Preferences): void {
  localStorage.setItem(key, JSON.stringify(value));
  if (typeof chrome !== 'undefined' && chrome.storage?.local)
    void chrome.storage.local.set({
      'magnetPreview.preferencesMirror.v1': value,
    });
  window.dispatchEvent(new Event('magnet-preview-preferences'));
}
