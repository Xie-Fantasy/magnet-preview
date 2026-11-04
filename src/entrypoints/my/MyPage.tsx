import { useEffect, useState } from 'react';
import { message, resolveLanguage } from '../../shared/i18n';
import { usePreferences } from '../../shared/usePreferences';
import { Icon, Wordmark } from '../../shared/Icons';
import type { LanguagePreference } from '../../shared/preferences/store';
import {
  getProviderConsent,
  setProviderConsent,
} from '../../shared/preferences/providerConsent';
import type {
  ScheduleTimezone,
  ThemeMode,
} from '../../shared/preferences/theme';
import { CachePage } from './CachePage';
import { PageToolSettings } from './PageToolSettings';
import type { PreviewCache } from '../../application/previewCache';
import type { FavoriteStore } from '../../application/favorites';
import { FavoritesPage } from './FavoritesPage';
import type { ExportLocale } from '../../application/favoriteExport';
import {
  getHoverEnabled,
  setHoverEnabled,
} from '../../shared/preferences/hover';

type Section = 'favorites' | 'cache' | 'settings';
export function MyPage({
  cache,
  favorites,
}: {
  cache: PreviewCache;
  favorites?: FavoriteStore;
}) {
  const [section, setSection] = useState<Section>(() =>
    location.hash === '#settings' ? 'settings' : 'favorites',
  );
  const [providerConsent, updateProviderConsent] = useState(getProviderConsent);
  const [hoverEnabled, updateHoverEnabled] = useState(getHoverEnabled);
  const { preferences, messages, changePreferences } = usePreferences();
  const t = (key: string) => message(messages, key);
  const exportLocale: ExportLocale = resolveLanguage(preferences.language);
  useEffect(() => {
    document.title = `${message(messages, 'extensionName')} — ${message(messages, 'myTitle')}`;
  }, [messages]);
  useEffect(() => {
    const sync = () => updateProviderConsent(getProviderConsent());
    const syncHover = () => updateHoverEnabled(getHoverEnabled());
    window.addEventListener('storage', sync);
    window.addEventListener('storage', syncHover);
    window.addEventListener('magnet-preview-provider-consent', sync);
    window.addEventListener('magnet-preview-hover-setting', syncHover);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('storage', syncHover);
      window.removeEventListener('magnet-preview-provider-consent', sync);
      window.removeEventListener('magnet-preview-hover-setting', syncHover);
    };
  }, []);
  return (
    <main
      className={`my-shell${section === 'favorites' ? ' my-favorites-shell' : ''}`}
    >
      <header className="my-header">
        <div className="my-identity">
          <Wordmark />
          <h1>{t('myTitle')}</h1>
        </div>
        <nav aria-label={t('myTitle')} className="tabs">
          {(['favorites', 'cache', 'settings'] as const).map((tab) => (
            <button
              key={tab}
              aria-current={section === tab ? 'page' : undefined}
              onClick={() => setSection(tab)}
            >
              <Icon
                name={
                  tab === 'favorites'
                    ? 'library'
                    : tab === 'cache'
                      ? 'cache'
                      : 'settings'
                }
              />
              {t(tab)}
            </button>
          ))}
        </nav>
      </header>
      <section className="my-content" aria-label={t(section)}>
        <h2>{t(section)}</h2>
        {section === 'favorites' && favorites ? (
          <FavoritesPage store={favorites} t={t} exportLocale={exportLocale} />
        ) : section === 'cache' ? (
          <CachePage t={t} cache={cache} />
        ) : section === 'settings' ? (
          <div className="settings-form">
            <h3>{t('appearanceSettings')}</h3>
            <label>
              {t('theme')}
              <select
                value={preferences.theme.mode}
                onChange={(event) =>
                  changePreferences({
                    ...preferences,
                    theme: {
                      ...preferences.theme,
                      mode: event.target.value as ThemeMode,
                    },
                  })
                }
              >
                {(['light', 'dark', 'system', 'schedule'] as const).map(
                  (mode) => (
                    <option key={mode} value={mode}>
                      {t(mode)}
                    </option>
                  ),
                )}
              </select>
            </label>
            {preferences.theme.mode === 'schedule' && (
              <label>
                {t('scheduleTimezone')}
                <select
                  value={preferences.theme.schedule.timezone}
                  onChange={(event) =>
                    changePreferences({
                      ...preferences,
                      theme: {
                        ...preferences.theme,
                        schedule: {
                          ...preferences.theme.schedule,
                          timezone: event.target.value as ScheduleTimezone,
                        },
                      },
                    })
                  }
                >
                  <option value="local">{t('localTimezone')}</option>
                  <option value="Asia/Shanghai">{t('chinaTimezone')}</option>
                </select>
              </label>
            )}
            <label>
              {t('language')}
              <select
                value={preferences.language}
                onChange={(event) =>
                  changePreferences({
                    ...preferences,
                    language: event.target.value as LanguagePreference,
                  })
                }
              >
                <option value="browser">{t('browserLanguage')}</option>
                <option value="en">English</option>
                <option value="zh_CN">简体中文</option>
              </select>
            </label>
            <h3>{t('previewSettings')}</h3>
            <label>
              {t('providerSetting')}
              <input
                type="checkbox"
                checked={providerConsent === true}
                onChange={(event) => {
                  setProviderConsent(event.target.checked);
                  updateProviderConsent(event.target.checked);
                }}
              />
            </label>
            <p className="muted">{t('providerSettingHelp')}</p>
            <p className="muted">
              {t('providerAbout')}{' '}
              <a
                href="https://whatslink.info/"
                target="_blank"
                rel="noopener noreferrer"
              >
                WhatsLink
              </a>
            </p>
            <label>
              {t('hoverSetting')}
              <input
                type="checkbox"
                checked={hoverEnabled}
                onChange={(event) => {
                  setHoverEnabled(event.target.checked);
                  updateHoverEnabled(event.target.checked);
                }}
              />
            </label>
            <p className="muted">{t('hoverSettingHelp')}</p>
            <PageToolSettings t={t} />
          </div>
        ) : (
          <p className="muted">{t(`${section}Empty`)}</p>
        )}
      </section>
    </main>
  );
}
