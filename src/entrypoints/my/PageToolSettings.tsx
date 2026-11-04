import { useEffect, useState } from 'react';
import {
  PAGE_TOOL_VISIBILITY_KEY,
  getPageToolVisibility,
  type PageToolVisibility,
} from '../../shared/preferences/pageToolVisibility';

export function PageToolSettings({ t }: { t: (key: string) => string }) {
  const [value, setValue] = useState<PageToolVisibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getPageToolVisibility()
        .then((next) => {
          if (active) setValue(next);
        })
        .catch(() => {
          if (active) setError(true);
        });
    };
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && PAGE_TOOL_VISIBILITY_KEY in changes) refresh();
    };
    refresh();
    chrome.storage?.onChanged?.addListener(changed);
    return () => {
      active = false;
      chrome.storage?.onChanged?.removeListener(changed);
    };
  }, []);
  const restore = async (site?: string) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'page-tools-restore',
        ...(site ? { site } : {}),
      });
      if (response?.kind !== 'restored') throw new Error('unavailable');
      setValue(await getPageToolVisibility());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('pageToolsSettings')}>
      <h3>{t('pageToolsSettings')}</h3>
      {value && (
        <>
          <div className="page-tool-setting-row">
            <span>
              {t(
                value.globalDisabled
                  ? 'pageToolsGloballyDisabled'
                  : 'pageToolsGloballyEnabled',
              )}
            </span>
            {value.globalDisabled && (
              <button disabled={busy} onClick={() => void restore()}>
                {t('pageToolsRestore')}
              </button>
            )}
          </div>
          {value.disabledSites.length > 0 && (
            <>
              <h4>{t('pageToolsDisabledSites')}</h4>
              <ul className="page-tool-disabled-sites">
                {value.disabledSites.map((site) => (
                  <li key={site} className="page-tool-setting-row">
                    <span>{site.slice(0, -2)}</span>
                    <button
                      disabled={busy}
                      onClick={() => void restore(site)}
                      aria-label={`${t('pageToolsRestore')} ${site.slice(0, -2)}`}
                    >
                      {t('pageToolsRestore')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted">{t('pageToolsRestoreNote')}</p>
        </>
      )}
      {error && <p role="alert">{t('pageToolsActionError')}</p>}
    </section>
  );
}
