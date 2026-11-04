import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { PreviewCache } from '../../application/previewCache';
import type { FavoriteStore } from '../../application/favorites';
import { FavoriteSaveFailure } from '../../application/favorites';
import type { NormalizedMagnet } from '../../domain/magnet';
import type { PreviewResult, PreviewState } from '../../domain/preview';
import { loadMessages, message } from '../../shared/i18n';
import { loadPreferences } from '../../shared/preferences/store';
import { resolveTheme } from '../../shared/preferences/theme';
import type { InlinePresentation } from '../../content/inlineRuntime';
import type { HoverPresentation } from '../../content/hoverRuntime';
import { getHoverEnabled } from '../../shared/preferences/hover';
import {
  announceFavoriteChange,
  subscribeFavoriteChanges,
} from '../../shared/favoriteEvents';
import {
  getProviderConsent,
  PROVIDER_CONSENT_VERSION,
  setProviderConsent,
} from '../../shared/preferences/providerConsent';
import { usePreferences } from '../../shared/usePreferences';
import { sitePattern, siteScriptId } from '../../shared/siteControl';
import { Icon, Wordmark } from '../../shared/Icons';
import { formatBytes } from '../../shared/formatBytes';
import { pageToolLabels } from '../../shared/pageToolLabels';
import { ScreenshotGallery } from '../../shared/ScreenshotGallery';

export const ScreenshotCacheContext = createContext<Pick<
  PreviewCache,
  'getAsset'
> | null>(null);
export const FavoriteStoreContext = createContext<FavoriteStore | null>(null);

export function Popup() {
  const favorites = useContext(FavoriteStoreContext);
  const [savedHashes, setSavedHashes] = useState<Set<string>>(new Set());
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [pendingHashes, setPendingHashes] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [favoriteStatus, setFavoriteStatus] = useState<
    | 'idle'
    | 'saving'
    | 'saved'
    | 'saved_partial'
    | 'removed'
    | 'quota'
    | 'failed'
  >('idle');
  const [favoriteMessages, setFavoriteMessages] = useState<
    Record<string, typeof favoriteStatus>
  >({});
  const [level, setLevel] = useState<1 | 2>(1);
  const [scan, setScan] = useState<'idle' | 'scanning' | 'unsupported'>('idle');
  const [hasScanned, setHasScanned] = useState(false);
  const [inlineStatus, setInlineStatus] = useState<
    'idle' | 'working' | 'ready' | 'unsupported'
  >('idle');
  const [siteAccess, setSiteAccess] = useState<{
    pattern: string;
    tabId: number;
    enabled: boolean;
  } | null>(null);
  const [siteAccessStatus, setSiteAccessStatus] = useState<
    'idle' | 'working' | 'error'
  >('idle');
  const [hoverEnabled, setHoverEnabled] = useState(getHoverEnabled);
  const [hoverActive, setHoverActive] = useState(false);
  const controlVersion = useRef(0);
  const [hoverStatus, setHoverStatus] = useState<
    'idle' | 'working' | 'ready' | 'removed' | 'disabled' | 'unsupported'
  >('idle');
  const [magnets, setMagnets] = useState<
    Array<{ magnet: NormalizedMagnet; occurrenceCount: number }>
  >([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<{
    magnet: NormalizedMagnet;
    occurrenceCount: number;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'failed'>(
    'idle',
  );
  const [consent, setConsent] = useState<boolean | null>(getProviderConsent);
  const lastConsent = useRef(getProviderConsent());
  const [previewStates, setPreviewStates] = useState<
    Record<string, PreviewState>
  >({});
  const [previewResults, setPreviewResults] = useState<
    Record<string, PreviewResult>
  >({});
  const detailButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const contentRef = useRef<HTMLElement | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const resultsScrollTop = useRef(0);
  const previewPort = useRef<chrome.runtime.Port | null>(null);
  const pageOptionsRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const options = pageOptionsRef.current;
      if (
        options?.open &&
        event.target instanceof Node &&
        !options.contains(event.target)
      )
        options.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const { messages } = usePreferences();
  const t = (key: string, substitutions?: string[]) =>
    message(messages, key, substitutions);
  const openMy = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('/my.html') });
  };
  useEffect(() => {
    if (!favorites) return;
    let active = true;
    const refresh = () => {
      void favorites.list().then(
        (items) => {
          if (active) {
            setSavedHashes(new Set(items.map((item) => item.infoHash)));
            setFavoritesReady(true);
          }
        },
        () => {
          if (active) {
            setFavoritesReady(false);
            setFavoriteStatus('failed');
          }
        },
      );
    };
    refresh();
    const unsubscribe = subscribeFavoriteChanges(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [favorites]);
  const toggleFavorite = async (magnet: NormalizedMagnet) => {
    if (!favorites || pendingRef.current.has(magnet.infoHash)) return;
    pendingRef.current.add(magnet.infoHash);
    setPendingHashes(new Set(pendingRef.current));
    const report = (status: typeof favoriteStatus) => {
      setFavoriteStatus(status);
      setFavoriteMessages((current) => ({
        ...current,
        [magnet.infoHash]: status,
      }));
    };
    report('saving');
    try {
      const wasSaved = savedHashes.has(magnet.infoHash);
      if (wasSaved) await favorites.remove(magnet.infoHash);
      const saved = wasSaved
        ? null
        : await favorites.save(
            magnet.canonicalMagnet,
            previewResults[magnet.infoHash],
          );
      setSavedHashes((current) => {
        const next = new Set(current);
        if (wasSaved) next.delete(magnet.infoHash);
        else next.add(magnet.infoHash);
        return next;
      });
      report(
        wasSaved
          ? 'removed'
          : saved && saved.missingImageCount > 0
            ? 'saved_partial'
            : 'saved',
      );
      announceFavoriteChange();
    } catch (error) {
      report(
        error instanceof FavoriteSaveFailure && error.reason === 'quota'
          ? 'quota'
          : 'failed',
      );
    } finally {
      pendingRef.current.delete(magnet.infoHash);
      setPendingHashes(new Set(pendingRef.current));
    }
  };
  useLayoutEffect(() => {
    if (!selected) return;
    if (contentRef.current)
      contentRef.current.scrollTop = level === 2 ? 0 : resultsScrollTop.current;
    if (level === 2) backButtonRef.current?.focus({ preventScroll: true });
    else
      detailButtons.current[selected.magnet.infoHash]?.focus({
        preventScroll: true,
      });
  }, [level, selected]);
  useEffect(() => {
    const sync = () => {
      const nextConsent = getProviderConsent();
      setConsent(nextConsent);
      if (nextConsent !== lastConsent.current && nextConsent !== true) {
        controlVersion.current++;
        setHoverActive(false);
        setInlineStatus('idle');
      }
      lastConsent.current = nextConsent;
    };
    const syncHover = () => {
      setHoverEnabled(getHoverEnabled());
      if (!getHoverEnabled()) setHoverActive(false);
    };
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
  useEffect(() => {
    let active = true;
    const version = controlVersion.current;
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab?.id) return;
        const status = await chrome.runtime.sendMessage({
          type: 'page-tools-status-tab',
          tabId: tab.id,
        });
        if (
          !active ||
          version !== controlVersion.current ||
          status?.kind !== 'success'
        )
          return;
        setHoverActive(status.hoverActive === true && getHoverEnabled());
        setInlineStatus(status.pageToolsActive === true ? 'ready' : 'idle');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab?.id || !tab.url) return;
        const pattern = sitePattern(tab.url);
        if (!pattern) return;
        const granted = await chrome.permissions.contains({
          origins: [pattern],
        });
        const scripts = await chrome.scripting.getRegisteredContentScripts({
          ids: [siteScriptId(pattern)],
        });
        if (active)
          setSiteAccess({
            pattern,
            tabId: tab.id!,
            enabled: granted && scripts.length > 0,
          });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (consent !== true) {
      setPreviewStates({});
      setPreviewResults({});
    }
  }, [consent]);
  useEffect(() => {
    if (consent !== true || magnets.length === 0) return;
    const port = chrome.runtime.connect({ name: 'preview' });
    previewPort.current = port;
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const input = message as Record<string, unknown>;
      if (typeof input.infoHash !== 'string') return;
      if (
        input.type === 'preview-state' &&
        input.state &&
        typeof input.state === 'object'
      ) {
        setPreviewStates((current) => ({
          ...current,
          [input.infoHash as string]: input.state as PreviewState,
        }));
      }
      if (
        input.type === 'preview-result' &&
        input.result &&
        typeof input.result === 'object'
      ) {
        setPreviewResults((current) => ({
          ...current,
          [input.infoHash as string]: input.result as PreviewResult,
        }));
      }
    });
    for (const item of magnets) {
      port.postMessage({
        type: 'preview',
        magnet: item.magnet.canonicalMagnet,
        infoHash: item.magnet.infoHash,
        consentVersion: PROVIDER_CONSENT_VERSION,
      });
    }
    return () => {
      if (previewPort.current === port) previewPort.current = null;
      port.disconnect();
    };
  }, [consent, magnets]);
  const retryPreview = (magnet: NormalizedMagnet) => {
    if (consent !== true || !previewPort.current) return;
    setPreviewResults((current) => {
      const next = { ...current };
      delete next[magnet.infoHash];
      return next;
    });
    setPreviewStates((current) => ({
      ...current,
      [magnet.infoHash]: { phase: 'queued' },
    }));
    try {
      previewPort.current.postMessage({
        type: 'preview',
        magnet: magnet.canonicalMagnet,
        infoHash: magnet.infoHash,
        consentVersion: PROVIDER_CONSENT_VERSION,
      });
    } catch {
      setPreviewStates((current) => ({
        ...current,
        [magnet.infoHash]: { phase: 'unavailable' },
      }));
    }
  };
  const scanPage = async () => {
    setScan('scanning');
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const response = (await chrome.runtime.sendMessage({
      type: 'scan-active-tab',
      tabId: tab?.id,
    })) as {
      kind: string;
      magnets?: Array<{ magnet: NormalizedMagnet; occurrenceCount: number }>;
      truncated?: boolean;
    };
    if (response.kind === 'success') {
      setPreviewStates({});
      setPreviewResults({});
      setMagnets(response.magnets ?? []);
      setTruncated(response.truncated === true);
      setScan('idle');
      setHasScanned(true);
    } else setScan('unsupported');
  };
  const openPageTools = async () => {
    controlVersion.current++;
    setInlineStatus('working');
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const preferences = loadPreferences();
      const catalog = await loadMessages(preferences.language);
      const label = (key: string) => message(catalog, key);
      const presentation: InlinePresentation = {
        theme: resolveTheme(
          preferences.theme,
          matchMedia('(prefers-color-scheme: dark)').matches,
        ),
        labels: {
          localOnly: label('inlineLocalOnly'),
          loading: label('inlineLoading'),
          unavailable: label('inlineUnavailable'),
          identity: label('magnetIdentity'),
          fileCount: label('previewFileCount'),
          size: label('previewSize'),
        },
      };
      const response = (await chrome.runtime.sendMessage({
        type: 'page-tools-open-tab',
        tabId: tab?.id,
        consent: getProviderConsent() === true,
        presentation,
        labels: pageToolLabels(label),
      })) as { kind: string };
      if (response.kind === 'disabled') {
        await chrome.tabs.create({
          url: chrome.runtime.getURL('/my.html#settings'),
        });
        setInlineStatus('idle');
        if (chrome.extension?.getViews?.({ type: 'popup' }).includes(window))
          window.close();
        return;
      }
      setInlineStatus(response.kind === 'ready' ? 'ready' : 'unsupported');
      if (
        response.kind === 'ready' &&
        chrome.extension?.getViews?.({ type: 'popup' }).includes(window)
      )
        window.close();
    } catch {
      setInlineStatus('unsupported');
    }
  };
  const toggleSiteAccess = async () => {
    if (!siteAccess || siteAccessStatus === 'working') return;
    setSiteAccessStatus('working');
    try {
      const { pattern, tabId, enabled } = siteAccess;
      const id = siteScriptId(pattern);
      if (enabled) {
        const removed = await chrome.permissions.remove({ origins: [pattern] });
        if (!removed) throw new Error('site_permission_retained');
        await chrome.scripting
          .unregisterContentScripts({ ids: [id] })
          .catch(() => undefined);
        await chrome.runtime.sendMessage({
          type: 'page-tools-revoke-tab',
          tabId,
        });
        setSiteAccess({ pattern, tabId, enabled: false });
      } else {
        const granted = await chrome.permissions.request({
          origins: [pattern],
        });
        if (!granted) {
          setSiteAccessStatus('idle');
          return;
        }
        try {
          const prior = await chrome.scripting.getRegisteredContentScripts({
            ids: [id],
          });
          if (prior.length)
            await chrome.scripting.unregisterContentScripts({ ids: [id] });
          await chrome.scripting.registerContentScripts([
            {
              id,
              matches: [pattern],
              js: ['auto-page-tools.js'],
              runAt: 'document_idle',
              persistAcrossSessions: true,
            },
          ]);
        } catch {
          await chrome.permissions
            .remove({ origins: [pattern] })
            .catch(() => undefined);
          throw new Error('site_registration_failed');
        }
        await chrome.storage.local.set({
          'magnetPreview.providerConsentMirror.v1':
            getProviderConsent() === true,
          'magnetPreview.preferencesMirror.v1': loadPreferences(),
        });
        setSiteAccess({ pattern, tabId, enabled: true });
        await openPageTools();
      }
      setSiteAccessStatus('idle');
    } catch {
      setSiteAccessStatus('error');
    }
  };
  const changeHover = async (remove: boolean) => {
    controlVersion.current++;
    if (!remove && !getHoverEnabled()) {
      setHoverStatus('disabled');
      return;
    }
    setHoverStatus('working');
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const preferences = loadPreferences();
      const catalog = await loadMessages(preferences.language);
      const label = (key: string) => message(catalog, key);
      const presentation: HoverPresentation = {
        theme: resolveTheme(
          preferences.theme,
          matchMedia('(prefers-color-scheme: dark)').matches,
        ),
        labels: {
          loading: label('inlineLoading'),
          unavailable: label('inlineUnavailable'),
          localOnly: label('inlineLocalOnly'),
          identity: label('magnetIdentity'),
          size: label('previewSize'),
          fileCount: label('previewFileCount'),
        },
      };
      const response = (await chrome.runtime.sendMessage({
        type: remove ? 'hover-remove-tab' : 'hover-activate-tab',
        tabId: tab?.id,
        enabled: getHoverEnabled(),
        consent: getProviderConsent() === true,
        presentation,
      })) as { kind: string };
      setHoverStatus(
        response.kind === 'success'
          ? 'ready'
          : response.kind === 'removed'
            ? 'removed'
            : response.kind === 'disabled'
              ? 'disabled'
              : 'unsupported',
      );
      if (response.kind === 'success') setHoverActive(true);
      else if (response.kind === 'removed' || response.kind === 'disabled')
        setHoverActive(false);
    } catch {
      setHoverStatus('unsupported');
    }
  };
  const occurrenceTotal = magnets.reduce(
    (total, item) => total + item.occurrenceCount,
    0,
  );
  const pageOptions = (
    <details
      className="popup-page-options"
      ref={pageOptionsRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={t('pageOptions')}>
        <span className="responsive-label-full">{t('pageOptions')}</span>
        <span className="responsive-label-short" aria-hidden="true">
          {t('pageOptionsShort')}
        </span>
      </summary>
      <div className="popup-page-options-panel">
        <div className="popup-primary-action">
          {siteAccess && (
            <button
              onClick={() => void toggleSiteAccess()}
              disabled={siteAccessStatus === 'working'}
              aria-pressed={siteAccess.enabled}
            >
              {t(
                siteAccess.enabled
                  ? 'pageToolsDisableSite'
                  : 'pageToolsEnableSite',
              )}
            </button>
          )}
          {hoverEnabled ? (
            <button
              className="popup-hover-toggle"
              onClick={() => void changeHover(hoverActive)}
              disabled={hoverStatus === 'working'}
              aria-label={t(hoverActive ? 'removeHover' : 'activateHover')}
              aria-pressed={hoverActive}
              aria-busy={hoverStatus === 'working'}
            >
              <span>{t('hoverSetting')}</span>
              <span className="toggle-state">
                {t(hoverActive ? 'enabledState' : 'disabledState')}
              </span>
            </button>
          ) : null}
        </div>
        {!hoverEnabled ? (
          <p className="muted">{t('hoverDisabledHelp')}</p>
        ) : null}
        {hoverStatus === 'unsupported' ? (
          <p className="muted" role="alert">
            {t('unsupportedPage')}
          </p>
        ) : null}
        {siteAccess && <p className="muted">{t('pageToolsSiteHelp')}</p>}
      </div>
    </details>
  );
  const detailFavoriteStatus = selected
    ? !favoritesReady && favoriteStatus === 'failed'
      ? 'failed'
      : (favoriteMessages[selected.magnet.infoHash] ?? 'idle')
    : 'idle';
  const footer = (
    <footer className="popup-footer">
      <span className="popup-nav-active" aria-current="page">
        <Icon name="page" />
        {t('popupTitle')}
      </span>
      <button onClick={openMy} aria-label={t('openMyPage')}>
        <Icon name="library" />
        <span className="responsive-label-full">{t('openMyPage')}</span>
        <span className="responsive-label-short" aria-hidden="true">
          {t('myPageShort')}
        </span>
      </button>
      {pageOptions}
    </footer>
  );
  if (level === 1) {
    return (
      <PopupShell
        contentRef={contentRef}
        footer={footer}
        header={
          <header className="popup-header">
            <div className="popup-heading">
              <Wordmark />
              <h1>{t('popupTitle')}</h1>
            </div>
            <div className="popup-header-actions">
              <button
                className="popup-secondary-button"
                onClick={() => void openPageTools()}
                disabled={inlineStatus === 'working'}
                aria-label={t('pageToolsOpen')}
                aria-pressed={inlineStatus === 'ready'}
                aria-busy={inlineStatus === 'working'}
              >
                <Icon name={inlineStatus === 'ready' ? 'check' : 'tools'} />
                <span className="page-tools-label">
                  {t(
                    inlineStatus === 'working'
                      ? 'pageToolsOpening'
                      : inlineStatus === 'ready'
                        ? 'pageToolsOpened'
                        : 'pageToolsShort',
                  )}
                </span>
              </button>
              <button
                className="popup-primary-button"
                onClick={() => void scanPage()}
                disabled={scan === 'scanning'}
                aria-label={t('scanPage')}
                aria-busy={scan === 'scanning'}
              >
                <Icon name="scan" />
                <span className="responsive-label-full">{t('scanPage')}</span>
                <span className="responsive-label-short" aria-hidden="true">
                  {t('scanPageShort')}
                </span>
              </button>
            </div>
          </header>
        }
      >
        {inlineStatus === 'unsupported' && (
          <p role="alert">{t('unsupportedPage')}</p>
        )}
        {siteAccessStatus === 'error' && (
          <p role="alert">{t('pageToolsSiteError')}</p>
        )}
        {scan === 'scanning' && magnets.length > 0 ? (
          <p className="muted" role="status">
            {t('scanningPage')}
          </p>
        ) : null}
        {scan === 'unsupported' && magnets.length > 0 ? (
          <p className="muted" role="status">
            {t('unsupportedPage')}
          </p>
        ) : null}
        {truncated ? (
          <p className="muted" role="status">
            {t('scanTruncated')}
          </p>
        ) : null}
        {magnets.length === 0 ? (
          <div
            className="popup-empty-state"
            role={scan !== 'idle' || hasScanned ? 'status' : undefined}
          >
            <div className="popup-empty-copy">
              <span className="popup-empty-kicker">{t('scanResults')}</span>
              <h2>
                {t(
                  scan === 'scanning'
                    ? 'scanningPage'
                    : scan === 'unsupported'
                      ? 'scanUnsupportedTitle'
                      : hasScanned
                        ? 'scanEmptyTitle'
                        : 'scanReadyTitle',
                )}
              </h2>
              <p>
                {t(
                  scan === 'scanning'
                    ? 'scanInProgressBody'
                    : scan === 'unsupported'
                      ? 'scanUnsupportedBody'
                      : hasScanned
                        ? 'scanEmpty'
                        : 'scanReadyBody',
                )}
              </p>
              {scan === 'idle' && (
                <span className="popup-empty-note">
                  <Icon name="library" />
                  {t('scanLocalHelp')}
                </span>
              )}
            </div>
            <svg
              className="popup-empty-art"
              viewBox="0 0 180 148"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="12"
                y="14"
                width="156"
                height="120"
                rx="8"
                stroke="currentColor"
              />
              <path
                d="M12 38h156M26 26h3m6 0h3m6 0h3"
                stroke="currentColor"
                strokeLinecap="round"
              />
              <rect
                x="26"
                y="52"
                width="32"
                height="20"
                rx="4"
                fill="currentColor"
                opacity=".1"
              />
              <path
                d="M70 57h70M70 66h45"
                stroke="currentColor"
                strokeLinecap="round"
                opacity=".45"
              />
              <rect
                x="26"
                y="82"
                width="32"
                height="20"
                rx="4"
                fill="currentColor"
                opacity=".1"
              />
              <path
                d="M70 87h58M70 96h35M26 116h88"
                stroke="currentColor"
                strokeLinecap="round"
                opacity=".45"
              />
              <path d="M4 77h172" stroke="var(--accent)" strokeWidth="2" />
              <circle cx="168" cy="77" r="3" fill="var(--accent)" />
            </svg>
          </div>
        ) : null}
        {magnets.length > 0 && consent === null ? (
          <section
            className="provider-consent"
            aria-label={t('providerConsentTitle')}
          >
            <h2>{t('providerConsentTitle')}</h2>
            <p>{t('providerConsentBody')}</p>
            <div className="consent-actions">
              <button
                onClick={() => {
                  setProviderConsent(true);
                  setConsent(true);
                }}
              >
                {t('enablePreviews')}
              </button>
              <button
                onClick={() => {
                  setProviderConsent(false);
                  setConsent(false);
                }}
              >
                {t('keepLocalOnly')}
              </button>
            </div>
          </section>
        ) : null}
        {magnets.length > 0 ? (
          <>
            <div className="popup-summary">
              <h2 className="popup-summary-label">
                <Icon name="page" />
                {t('scanResults')}
              </h2>
              <span className="popup-summary-counts">
                {t('resultResourceCount', [String(magnets.length)])} ·{' '}
                {t('resultLinkCount', [String(occurrenceTotal)])}
                <span className="popup-merge-note">{t('mergedInfoHash')}</span>
              </span>
              <span
                className="popup-summary-mode"
                title={consent === false ? t('localOnlyNotice') : undefined}
              >
                {consent === true
                  ? t('onlinePreviewMode')
                  : t('localOnlyBadge')}
                {consent === false && (
                  <button
                    className="popup-enable-previews"
                    onClick={() => {
                      setProviderConsent(true);
                      setConsent(true);
                    }}
                  >
                    {t('enablePreviews')}
                  </button>
                )}
              </span>
            </div>
            <div aria-label={t('resourceList')} className="resource-list">
              {magnets.map(({ magnet, occurrenceCount }) => (
                <ResourceCard
                  key={magnet.infoHash}
                  magnet={magnet}
                  preview={previewResults[magnet.infoHash]}
                  previewState={previewStates[magnet.infoHash]}
                  consent={consent}
                  occurrenceCount={occurrenceCount}
                  actionRef={(element) => {
                    detailButtons.current[magnet.infoHash] = element;
                  }}
                  onOpen={() => {
                    resultsScrollTop.current =
                      contentRef.current?.scrollTop ?? 0;
                    setSelected({ magnet, occurrenceCount });
                    setCopyStatus('idle');
                    setLevel(2);
                  }}
                  isFavorite={savedHashes.has(magnet.infoHash)}
                  favoritePending={pendingHashes.has(magnet.infoHash)}
                  onFavorite={
                    favorites && favoritesReady
                      ? () => void toggleFavorite(magnet)
                      : undefined
                  }
                  t={t}
                />
              ))}
            </div>
          </>
        ) : null}
        {favoriteStatus !== 'idle' && (
          <p
            role={
              favoriteStatus === 'failed' || favoriteStatus === 'quota'
                ? 'alert'
                : 'status'
            }
            className="muted"
          >
            {t(favoriteStatusMessage(favoriteStatus))}
          </p>
        )}
      </PopupShell>
    );
  }
  return (
    <PopupShell
      contentRef={contentRef}
      footer={footer}
      header={
        <header className="popup-header popup-detail-header">
          <button
            className="popup-back"
            ref={backButtonRef}
            onClick={() => setLevel(1)}
          >
            <Icon name="back" />
            {t('back')}
          </button>
          <h1>{t('detailTitle')}</h1>
        </header>
      }
    >
      {selected ? (
        <>
          <ResourceDetail
            occurrenceCount={selected.occurrenceCount}
            copyStatus={copyStatus}
            magnet={selected.magnet}
            preview={previewResults[selected.magnet.infoHash]}
            previewState={previewStates[selected.magnet.infoHash]}
            isFavorite={savedHashes.has(selected.magnet.infoHash)}
            favoritePending={pendingHashes.has(selected.magnet.infoHash)}
            favoriteMessage={
              detailFavoriteStatus === 'idle'
                ? undefined
                : t(favoriteStatusMessage(detailFavoriteStatus))
            }
            favoriteFailed={
              detailFavoriteStatus === 'failed' ||
              detailFavoriteStatus === 'quota'
            }
            onFavorite={
              favorites && favoritesReady
                ? () => {
                    setCopyStatus('idle');
                    void toggleFavorite(selected.magnet);
                  }
                : undefined
            }
            onCopy={async () => {
              try {
                await navigator.clipboard.writeText(
                  selected.magnet.canonicalMagnet,
                );
                setCopyStatus('success');
              } catch {
                setCopyStatus('failed');
              }
            }}
            onRetry={
              consent === true ? () => retryPreview(selected.magnet) : undefined
            }
            t={t}
          />
        </>
      ) : (
        <p className="muted">{t('detailEmpty')}</p>
      )}
    </PopupShell>
  );
}

function PopupShell({
  children,
  contentRef,
  footer,
  header,
}: {
  children: ReactNode;
  contentRef: RefObject<HTMLElement | null>;
  footer: ReactNode;
  header: ReactNode;
}) {
  const shellRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const fitToViewport = () => {
      const shell = shellRef.current;
      if (!shell) return;
      // Action Popups start with a tiny provisional viewport while Chromium
      // measures intrinsic content. Keep the fixed CSS size until it settles.
      if (window.innerWidth > 80)
        shell.style.inlineSize = `${Math.min(760, window.innerWidth)}px`;
      if (window.innerHeight > 80)
        shell.style.blockSize = `${Math.min(500, window.innerHeight)}px`;
    };
    fitToViewport();
    const frame = requestAnimationFrame(fitToViewport);
    window.addEventListener('resize', fitToViewport);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fitToViewport);
    };
  }, []);
  return (
    <main className="popup-shell" ref={shellRef}>
      {header}
      <section className="popup-content" ref={contentRef}>
        {children}
      </section>
      {footer}
    </main>
  );
}

function ResourceCard({
  actionRef,
  consent,
  favoritePending,
  isFavorite,
  magnet,
  occurrenceCount,
  onFavorite,
  onOpen,
  preview,
  previewState,
  t,
}: {
  actionRef: (element: HTMLButtonElement | null) => void;
  consent: boolean | null;
  favoritePending: boolean;
  isFavorite: boolean;
  magnet: NormalizedMagnet;
  occurrenceCount: number;
  onFavorite?: () => void;
  onOpen: () => void;
  preview?: PreviewResult;
  previewState?: PreviewState;
  t: (key: string, substitutions?: string[]) => string;
}) {
  const [cardCopyStatus, setCardCopyStatus] = useState<
    'idle' | 'success' | 'failed'
  >('idle');
  useEffect(() => {
    if (cardCopyStatus === 'idle') return;
    const timer = window.setTimeout(() => setCardCopyStatus('idle'), 4000);
    return () => window.clearTimeout(timer);
  }, [cardCopyStatus]);
  const shortInfoHash = magnet.infoHash.slice(0, 12);
  const name =
    preview?.name ||
    magnet.displayName?.trim() ||
    `${t('infoHash')} ${shortInfoHash}`;
  const titleId = `resource-${magnet.infoHash}`;
  const previewSummary = preview ? formatPreviewSummary(preview, t) : '';
  const status = preview
    ? t('previewAvailable')
    : consent !== true
      ? t('localOnlyBadge')
      : previewState?.phase === 'unavailable'
        ? t('previewUnavailableShort')
        : previewState?.phase === 'requesting'
          ? t('previewRequestingShort')
          : previewState?.phase === 'queued'
            ? t('previewWaiting')
            : t('previewWaiting');
  const statusDetail = preview
    ? preview.screenshots.length > 0
      ? t('previewImageCount', [String(preview.screenshots.length)])
      : t('previewMetadataOnly')
    : previewState?.phase === 'unavailable' && consent === true
      ? t('previewUnavailableHint')
      : '';
  return (
    <article aria-labelledby={titleId} className="resource-card" tabIndex={0}>
      <div className="resource-card-media">
        <span className="resource-card-media-empty" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect
              x="3"
              y="5"
              width="18"
              height="14"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle
              cx="9"
              cy="10"
              r="1.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="m5 17 5-4 3 2 3-3 3 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t('noPreview')}
        </span>
        {preview?.screenshots[0]?.sourceUrl ? (
          <PreviewScreenshot
            url={preview.screenshots[0].sourceUrl}
            cachedAssetKey={preview.screenshots[0].cachedAssetKey}
            label={t('previewScreenshot')}
            fallback={t('screenshotUnavailable')}
            compact
          />
        ) : null}
      </div>
      <div className="resource-card-content">
        <h2 id={titleId} title={name}>
          {name}
        </h2>
        <div className="resource-card-metadata">
          {previewSummary ? <span>{previewSummary}</span> : null}
          {previewSummary ? <span aria-hidden="true">·</span> : null}
          <span>{occurrenceLabel(t, occurrenceCount)}</span>
        </div>
        <div className="resource-card-hash">
          <code aria-label={t('infoHash')} title={magnet.infoHash}>
            {t('infoHash')} {shortInfoHash}…
          </code>
        </div>
      </div>
      <div className="resource-card-status">
        <span
          className={preview ? 'status-badge is-available' : 'status-badge'}
        >
          {status}
        </span>
        <span
          className={`resource-card-status-detail${cardCopyStatus === 'success' ? ' copy-succeeded' : ''}`}
        >
          {cardCopyStatus === 'success'
            ? t('magnetCopied')
            : cardCopyStatus === 'failed'
              ? t('copyFailed')
              : statusDetail}
        </span>
      </div>
      <div className="resource-card-actions">
        <button
          className="resource-detail-button"
          onClick={onOpen}
          ref={actionRef}
        >
          {t('openDetail')} <span aria-hidden="true">›</span>
        </button>
        <div className="resource-shortcuts">
          <button
            aria-label={t('copyMagnet')}
            title={t(
              cardCopyStatus === 'success'
                ? 'magnetCopied'
                : cardCopyStatus === 'failed'
                  ? 'copyFailed'
                  : 'copyMagnet',
            )}
            data-copy-state={cardCopyStatus}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(magnet.canonicalMagnet);
                setCardCopyStatus('success');
              } catch {
                setCardCopyStatus('failed');
              }
            }}
          >
            {cardCopyStatus !== 'idle' ? (
              <Icon name={cardCopyStatus === 'success' ? 'check' : 'warning'} />
            ) : (
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <rect
                  x="7"
                  y="6"
                  width="9"
                  height="11"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M5 13H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            )}
          </button>
          {onFavorite && (
            <button
              onClick={onFavorite}
              aria-label={t(isFavorite ? 'removeFavorite' : 'addFavorite')}
              title={t(isFavorite ? 'removeFavorite' : 'addFavorite')}
              aria-pressed={isFavorite}
              disabled={favoritePending}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="m10 2.5 2.3 4.7 5.2.8-3.8 3.7.9 5.2L10 14.4l-4.6 2.5.9-5.2L2.5 8l5.2-.8L10 2.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
        <span className="visually-hidden" role="status">
          {cardCopyStatus === 'success'
            ? t('magnetCopied')
            : cardCopyStatus === 'failed'
              ? t('copyFailed')
              : ''}
        </span>
      </div>
    </article>
  );
}

function ResourceDetail({
  copyStatus,
  favoritePending,
  favoriteMessage,
  favoriteFailed,
  isFavorite,
  magnet,
  occurrenceCount,
  onCopy,
  onRetry,
  onFavorite,
  preview,
  previewState,
  t,
}: {
  copyStatus: 'idle' | 'success' | 'failed';
  favoritePending: boolean;
  favoriteMessage?: string;
  favoriteFailed?: boolean;
  isFavorite: boolean;
  magnet: NormalizedMagnet;
  occurrenceCount: number;
  onCopy: () => Promise<void>;
  onRetry?: () => void;
  onFavorite?: () => void;
  preview?: PreviewResult;
  previewState?: PreviewState;
  t: (key: string, substitutions?: string[]) => string;
}) {
  const shortInfoHash = magnet.infoHash.slice(0, 12);
  const name =
    preview?.name ||
    magnet.displayName?.trim() ||
    `${t('infoHash')} ${shortInfoHash}`;
  const actionMessage =
    copyStatus === 'idle'
      ? (favoriteMessage ?? '')
      : copyStatus === 'success'
        ? t('magnetCopied')
        : t('copyFailed');
  return (
    <div className="resource-detail">
      <h2>{name}</h2>
      <div className="resource-detail-actions">
        <button onClick={() => void onCopy()}>{t('copyMagnet')}</button>
        {onFavorite && (
          <button
            className="detail-favorite-button"
            onClick={onFavorite}
            aria-pressed={isFavorite}
            disabled={favoritePending}
          >
            <span className="detail-favorite-size" aria-hidden="true">
              {t('removeFavorite')}
            </span>
            <span>{t(isFavorite ? 'removeFavorite' : 'addFavorite')}</span>
          </button>
        )}
        <span
          className="detail-action-feedback"
          role={copyStatus === 'idle' && favoriteFailed ? 'alert' : 'status'}
          title={actionMessage || undefined}
        >
          {actionMessage}
        </span>
      </div>

      {preview ? (
        <section className="preview-details" aria-label={t('previewTitle')}>
          <ScreenshotGallery
            key={preview.infoHash}
            className="preview-screenshots"
            t={t}
            heading={
              <div className="preview-summary">
                <h2>{t('previewTitle')}</h2>
                <dl className="detail-metadata">
                  {preview.totalBytes !== undefined ? (
                    <div>
                      <dt>{t('previewSize')}</dt>
                      <dd>{formatBytes(preview.totalBytes)}</dd>
                    </div>
                  ) : null}
                  {preview.fileCount !== undefined ? (
                    <div>
                      <dt>{t('previewFileCount')}</dt>
                      <dd>{preview.fileCount}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            }
          >
            {preview.screenshots.map((image, index) =>
              image.sourceUrl ? (
                <PreviewScreenshot
                  key={image.id}
                  url={image.sourceUrl}
                  cachedAssetKey={image.cachedAssetKey}
                  label={`${t('previewScreenshot')} ${index + 1}`}
                  fallback={t('screenshotUnavailable')}
                />
              ) : null,
            )}
          </ScreenshotGallery>
          {preview.screenshots.length === 0 && (
            <p className="muted">{t('noScreenshots')}</p>
          )}
          {preview.files && preview.files.length > 0 ? (
            <section className="preview-files" aria-label={t('previewFiles')}>
              <h3>{t('previewFiles')}</h3>
              <ul>
                {preview.files.map((file, index) => (
                  <li key={`${index}:${file.path}`}>
                    <span>{file.path}</span>
                    {file.bytes !== undefined ? (
                      <span className="muted">{formatBytes(file.bytes)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="provider-attribution">
            {t('providedBy')}{' '}
            <a
              href="https://whatslink.info/"
              target="_blank"
              rel="noopener noreferrer"
            >
              WhatsLink
            </a>
          </p>
        </section>
      ) : previewState ? (
        <p className="muted" role="status">
          {stateLabel(previewState, t)}
        </p>
      ) : null}
      {previewState?.phase === 'unavailable' && onRetry ? (
        <button onClick={onRetry}>{t('retryPreview')}</button>
      ) : null}
      <dl className="detail-metadata">
        <div>
          <dt>{t('infoHash')}</dt>
          <dd>
            <code className="detail-value">{magnet.infoHash}</code>
          </dd>
        </div>
        <div>
          <dt>{t('occurrenceCount')}</dt>
          <dd>{occurrenceLabel(t, occurrenceCount)}</dd>
        </div>
      </dl>
      <section aria-label={t('magnetValue')} className="magnet-value-section">
        <h2>{t('magnetValue')}</h2>
        <div className="detail-value detail-magnet" tabIndex={0}>
          <code>{magnet.canonicalMagnet}</code>
        </div>
      </section>
    </div>
  );
}

function PreviewScreenshot({
  url,
  cachedAssetKey,
  label,
  fallback,
  compact = false,
}: {
  url: string;
  cachedAssetKey?: string;
  label: string;
  fallback: string;
  compact?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const screenshotCache = useContext(ScreenshotCacheContext);
  const [cached, setCached] = useState<{ key: string; src: string } | null>(
    null,
  );
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!cachedAssetKey) return;
    if (!screenshotCache) {
      setCheckedKey(cachedAssetKey);
      return;
    }
    let active = true;
    let objectUrl: string | undefined;
    void screenshotCache
      .getAsset(cachedAssetKey)
      .then((blob) => {
        if (!active) return;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          setCached({ key: cachedAssetKey, src: objectUrl });
        }
        setCheckedKey(cachedAssetKey);
      })
      .catch(() => {
        if (active) setCheckedKey(cachedAssetKey);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cachedAssetKey, screenshotCache]);
  const source = cachedAssetKey
    ? cached?.key === cachedAssetKey
      ? cached.src
      : undefined
    : url;
  const missing =
    broken || (!source && cachedAssetKey && checkedKey === cachedAssetKey);
  const image =
    source && !broken ? (
      <img
        className={compact ? 'preview-thumb' : undefined}
        src={source}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        crossOrigin="anonymous"
        onError={() => setBroken(true)}
      />
    ) : null;
  if (compact) return image;
  return (
    <div
      className="preview-image-frame"
      aria-busy={Boolean(
        cachedAssetKey && !source && checkedKey !== cachedAssetKey && !broken,
      )}
    >
      {missing ? <p className="muted">{fallback}</p> : image}
    </div>
  );
}

function formatPreviewSummary(
  preview: PreviewResult,
  t: (key: string) => string,
): string {
  const parts = [
    preview.totalBytes === undefined ? null : formatBytes(preview.totalBytes),
    preview.fileCount === undefined
      ? null
      : preview.fileCount + ' ' + t('filesShort'),
  ].filter(Boolean);
  return parts.join(' · ');
}

function stateLabel(state: PreviewState, t: (key: string) => string): string {
  if (state.phase === 'queued') return t('previewQueued');
  if (state.phase === 'requesting') return t('previewRequesting');
  if (state.phase === 'unavailable') {
    const category = state.technicalDetails?.category;
    if (category === 'rate_limited' || category === 'circuit_open')
      return t('previewRateLimited');
    if (category === 'not_found') return t('previewNotFound');
    return t('previewUnavailable');
  }
  return t('magnetIdentity');
}

function occurrenceLabel(
  t: (key: string, substitutions?: string[]) => string,
  count: number,
): string {
  return count === 1 ? t('occurrenceOnce') : t('occurrences', [String(count)]);
}

function favoriteStatusMessage(
  status: 'saving' | 'saved' | 'saved_partial' | 'removed' | 'quota' | 'failed',
): string {
  if (status === 'saving') return 'favoriteSaving';
  if (status === 'saved') return 'favoriteSaved';
  if (status === 'saved_partial') return 'favoriteSavedPartial';
  if (status === 'removed') return 'favoriteRemoved';
  if (status === 'quota') return 'favoriteQuotaFailure';
  return 'favoriteFailed';
}
