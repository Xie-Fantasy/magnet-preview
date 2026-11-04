import type { LanguagePreference } from './preferences/store';

export type Messages = Record<string, string>;
type Catalog = Record<string, { message: string }>;

export function resolveLanguage(language: LanguagePreference): 'en' | 'zh_CN' {
  return language === 'browser'
    ? chrome.i18n.getUILanguage().toLowerCase().startsWith('zh')
      ? 'zh_CN'
      : 'en'
    : language;
}

export async function loadMessages(
  language: LanguagePreference,
): Promise<Messages> {
  const locale = resolveLanguage(language);
  const response = await fetch(
    chrome.runtime.getURL(`/_locales/${locale}/messages.json`),
  );
  if (!response.ok) throw new Error('Unable to load extension locale catalog');
  const catalog = (await response.json()) as Catalog;
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]) => [key, value.message]),
  );
}

export function message(
  messages: Messages,
  key: string,
  substitutions: string[] = [],
): string {
  const fallback = messages[key];
  if (fallback)
    return substitutions.reduce(
      (value, substitution, index) =>
        value.replace(
          new RegExp(`\\$${index + 1}\\$|\\$COUNT\\$`, 'g'),
          substitution,
        ),
      fallback,
    );
  return chrome.i18n.getMessage(key, substitutions) || key;
}
