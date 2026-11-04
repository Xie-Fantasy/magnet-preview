import { useEffect, useState } from 'react';
import {
  loadPreferences,
  savePreferences,
  type Preferences,
} from './preferences/store';
import { resolveTheme } from './preferences/theme';
import { loadMessages, resolveLanguage, type Messages } from './i18n';

export function usePreferences() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [messages, setMessages] = useState<Messages>({});
  useEffect(() => {
    document.documentElement.lang =
      resolveLanguage(preferences.language) === 'zh_CN' ? 'zh-CN' : 'en';
    let active = true;
    loadMessages(preferences.language).then((value) => {
      if (active) setMessages(value);
    });
    return () => {
      active = false;
    };
  }, [preferences.language]);
  useEffect(() => {
    const update = () => setPreferences(loadPreferences());
    window.addEventListener('storage', update);
    window.addEventListener('magnet-preview-preferences', update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('magnet-preview-preferences', update);
    };
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme = resolveTheme(
        preferences.theme,
        media.matches,
      );
    };
    update();
    media.addEventListener('change', update);
    const timer = window.setInterval(update, 60_000);
    return () => {
      media.removeEventListener('change', update);
      window.clearInterval(timer);
    };
  }, [preferences.theme]);
  const changePreferences = (next: Preferences) => {
    savePreferences(next);
    setPreferences(next);
  };
  return { preferences, messages, changePreferences };
}
