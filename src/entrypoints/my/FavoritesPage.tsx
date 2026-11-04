import { useEffect, useRef, useState } from 'react';
import { ScreenshotGallery } from '../../shared/ScreenshotGallery';
import type {
  FavoriteRecord,
  FavoriteStore,
} from '../../application/favorites';
import {
  exportFavorites,
  type ExportFormat,
  type ExportLocale,
} from '../../application/favoriteExport';
import {
  announceFavoriteChange,
  subscribeFavoriteChanges,
} from '../../shared/favoriteEvents';
import { formatBytes } from '../../shared/formatBytes';
import { Icon } from '../../shared/Icons';

const EXPANDED_DEFAULT_KEY = 'magnet-preview.favorites.expanded-default.v1';

function favoriteTitle(item: FavoriteRecord, hashLabel: string): string {
  if (item.snapshot?.name) return item.snapshot.name;
  try {
    return (
      new URL(item.magnet).searchParams.get('dn') ||
      `${hashLabel} ${item.infoHash.slice(0, 12)}`
    );
  } catch {
    return `${hashLabel} ${item.infoHash.slice(0, 12)}`;
  }
}

export function FavoritesPage({
  store,
  t,
  exportLocale = 'en',
}: {
  store: FavoriteStore;
  t: (key: string) => string;
  exportLocale?: ExportLocale;
}) {
  const [items, setItems] = useState<FavoriteRecord[]>([]);
  const [query, setQuery] = useState('');
  const [expandedDefault, setExpandedDefault] = useState(
    () => localStorage.getItem(EXPANDED_DEFAULT_KEY) === 'true',
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const noticeTimer = useRef<number | null>(null);
  const exportBusy = useRef(false);
  const mounted = useRef(true);
  const exportUrls = useRef(new Map<string, number>());
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'error' | 'copied' | 'copy_failed' | 'removed'
  >('loading');
  useEffect(() => {
    mounted.current = true;
    return () => {
      if (noticeTimer.current !== null)
        window.clearTimeout(noticeTimer.current);
      mounted.current = false;
      for (const [url, timer] of exportUrls.current) {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      exportUrls.current.clear();
    };
  }, []);
  const showCopyNotice = (result: 'copied' | 'copy_failed') => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setStatus(result);
    noticeTimer.current = window.setTimeout(() => {
      setStatus((current) => (current === result ? 'ready' : current));
      noticeTimer.current = null;
    }, 3000);
  };
  const [exportStatus, setExportStatus] = useState<
    'idle' | 'working' | 'done' | 'too_large' | 'failed'
  >('idle');
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void store.list().then(
        (records) => {
          if (active) {
            setItems(records);
            setStatus((current) => (current === 'loading' ? 'ready' : current));
          }
        },
        () => {
          if (active) setStatus('error');
        },
      );
    };
    refresh();
    const unsubscribe = subscribeFavoriteChanges(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [store]);
  const visibleItems = items.filter((item) =>
    favoriteTitle(item, t('infoHash'))
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const isExpanded = (infoHash: string) =>
    expanded[infoHash] ?? expandedDefault;
  const setAllExpanded = (value: boolean) => {
    setExpanded((current) => ({
      ...current,
      ...Object.fromEntries(visibleItems.map((item) => [item.infoHash, value])),
    }));
  };
  const copyMagnet = (magnet: string) => {
    void navigator.clipboard.writeText(magnet).then(
      () => showCopyNotice('copied'),
      () => showCopyNotice('copy_failed'),
    );
  };
  const remove = async (infoHash: string) => {
    try {
      await store.remove(infoHash);
      setItems((records) =>
        records.filter((item) => item.infoHash !== infoHash),
      );
      setStatus('removed');
      announceFavoriteChange();
    } catch {
      setStatus('error');
    }
  };
  const download = async (format: ExportFormat) => {
    if (exportBusy.current) return;
    exportBusy.current = true;
    setExportStatus('working');
    try {
      const file = await exportFavorites(
        store,
        format,
        undefined,
        exportLocale,
      );
      if (!mounted.current) return;
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `magnet-preview-favorites.${format}`;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        const timer = window.setTimeout(() => {
          URL.revokeObjectURL(url);
          exportUrls.current.delete(url);
        }, 60_000);
        exportUrls.current.set(url, timer);
      }
      setExportStatus('done');
    } catch (error) {
      if (mounted.current)
        setExportStatus(
          error instanceof Error &&
            [
              'html_too_large',
              'json_too_large',
              'export_too_large',
              'too_many_favorites',
            ].includes(error.message)
            ? 'too_large'
            : 'failed',
        );
    } finally {
      exportBusy.current = false;
    }
  };
  return (
    <div className="favorites-page">
      {items.length > 0 && (
        <div className="favorite-export" aria-label={t('exportFavorites')}>
          <span>{t('exportFavorites')}</span>
          <button
            disabled={exportStatus === 'working'}
            onClick={() => void download('html')}
          >
            {t('exportHtml')}
          </button>
          <button
            disabled={exportStatus === 'working'}
            onClick={() => void download('zip')}
          >
            {t('exportZip')}
          </button>
          <button
            disabled={exportStatus === 'working'}
            onClick={() => void download('json')}
          >
            {t('exportJson')}
          </button>
        </div>
      )}
      {exportStatus === 'working' && <p role="status">{t('exportWorking')}</p>}
      {exportStatus === 'done' && <p role="status">{t('exportReady')}</p>}
      {exportStatus === 'too_large' && (
        <p role="alert">{t('exportTooLarge')}</p>
      )}
      {exportStatus === 'failed' && <p role="alert">{t('exportFailed')}</p>}
      {status === 'loading' && (
        <p role="status" className="muted">
          {t('favoritesLoading')}
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="muted">
          {t('favoriteFailed')}
        </p>
      )}
      {status === 'removed' && (
        <p role="status" className="muted">
          {t('favoriteRemoved')}
        </p>
      )}
      {status === 'copied' && (
        <div role="status" className="favorite-message">
          {t('magnetCopied')}
        </div>
      )}
      {status === 'copy_failed' && (
        <div role="alert" className="favorite-message">
          {t('copyFailed')}
        </div>
      )}
      {status !== 'loading' && status !== 'error' && items.length === 0 && (
        <div className="collection-empty">
          <Icon name="library" />
          <p>{t('favoritesEmpty')}</p>
          <span>{t('favoriteEmptyHelp')}</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="favorite-browser">
          <aside
            className="favorite-sidebar"
            aria-label={t('favoriteNavigation')}
          >
            <label htmlFor="favorite-search">{t('favoriteSearch')}</label>
            <input
              id="favorite-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('favoriteSearch')}
            />
            <nav aria-label={t('favoriteNavigation')}>
              {visibleItems.map((item) => (
                <a
                  key={item.infoHash}
                  href={`#favorite-${item.infoHash}`}
                  title={favoriteTitle(item, t('infoHash'))}
                >
                  {favoriteTitle(item, t('infoHash'))}
                </a>
              ))}
            </nav>
          </aside>
          <div className="favorite-results">
            <div className="favorite-view-controls">
              <label>
                <input
                  type="checkbox"
                  checked={expandedDefault}
                  onChange={(event) => {
                    const value = event.target.checked;
                    localStorage.setItem(EXPANDED_DEFAULT_KEY, String(value));
                    setExpandedDefault(value);
                    setExpanded({});
                  }}
                />
                {t('favoriteDefaultExpanded')}
              </label>
              <button onClick={() => setAllExpanded(true)}>
                {t('expandAll')}
              </button>
              <button onClick={() => setAllExpanded(false)}>
                {t('collapseAll')}
              </button>
            </div>
            {visibleItems.length === 0 && (
              <p className="muted favorite-no-matches" role="status">
                {t('favoriteNoMatches')}
              </p>
            )}
            <div className="favorite-list">
              {visibleItems.map((item) => {
                const open = isExpanded(item.infoHash);
                const title = favoriteTitle(item, t('infoHash'));
                return (
                  <article id={`favorite-${item.infoHash}`} key={item.infoHash}>
                    <div className="favorite-card-summary">
                      <div className="favorite-media">
                        <span
                          className="favorite-media-empty"
                          aria-hidden="true"
                        >
                          <Icon name="image" />
                          {t('noPreview')}
                        </span>
                        {item.assetIds[0] && (
                          <FavoriteImage
                            store={store}
                            infoHash={item.infoHash}
                            imageId={item.assetIds[0]}
                            alt={t('previewScreenshot')}
                            fallback={t('favoriteImageMissing')}
                            loadingText={t('favoriteImageLoading')}
                            compact
                          />
                        )}
                      </div>
                      <div className="favorite-card-content">
                        <h3>{title}</h3>
                        <p className="muted favorite-summary-meta">
                          {item.snapshot?.totalBytes !== undefined &&
                            `${t('previewSize')}: ${formatBytes(item.snapshot.totalBytes)} · `}
                          {item.snapshot?.fileCount !== undefined &&
                            `${t('previewFileCount')}: ${item.snapshot.fileCount} · `}
                          <code>{item.infoHash.slice(0, 12)}…</code>
                        </p>
                        <div className="favorite-actions">
                          <button
                            aria-expanded={open}
                            aria-controls={`favorite-details-${item.infoHash}`}
                            onClick={() =>
                              setExpanded((current) => ({
                                ...current,
                                [item.infoHash]: !open,
                              }))
                            }
                          >
                            {t(open ? 'collapseFavorite' : 'openDetail')}
                          </button>
                          <button onClick={() => copyMagnet(item.magnet)}>
                            {t('copyMagnet')}
                          </button>
                          <button
                            className="destructive-action"
                            onClick={() => void remove(item.infoHash)}
                          >
                            {t('removeFavorite')}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div
                      id={`favorite-details-${item.infoHash}`}
                      hidden={!open}
                    >
                      {open && (
                        <>
                          <dl className="favorite-detail-metadata">
                            <div>
                              <dt>{t('infoHash')}</dt>
                              <dd>
                                <code>{item.infoHash}</code>
                              </dd>
                            </div>
                            {item.snapshot?.totalBytes !== undefined && (
                              <div>
                                <dt>{t('previewSize')}</dt>
                                <dd>
                                  {formatBytes(item.snapshot.totalBytes)} (
                                  {item.snapshot.totalBytes.toLocaleString()} B)
                                </dd>
                              </div>
                            )}
                            {item.snapshot?.fileCount !== undefined && (
                              <div>
                                <dt>{t('previewFileCount')}</dt>
                                <dd>{item.snapshot.fileCount}</dd>
                              </div>
                            )}
                          </dl>
                          {(item.snapshot?.screenshots.length ||
                            item.assetIds.length) > 0 && (
                            <ScreenshotGallery
                              className="favorite-images"
                              t={t}
                            >
                              {(
                                item.snapshot?.screenshots.map(
                                  (image) => image.id,
                                ) ?? item.assetIds
                              ).map((imageId, index) => (
                                <FavoriteImage
                                  key={imageId}
                                  store={store}
                                  infoHash={item.infoHash}
                                  imageId={imageId}
                                  alt={`${t('previewScreenshot')} ${index + 1}`}
                                  fallback={t('favoriteImageMissing')}
                                  loadingText={t('favoriteImageLoading')}
                                />
                              ))}
                            </ScreenshotGallery>
                          )}
                          {item.missingImageCount > 0 && (
                            <p className="muted">{t('favoriteIncomplete')}</p>
                          )}
                          <div className="favorite-magnet-field">
                            <span className="muted">{t('magnetValue')}</span>
                            <div
                              className="detail-value detail-magnet"
                              tabIndex={0}
                            >
                              <code>{item.magnet}</code>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FavoriteImage({
  store,
  infoHash,
  imageId,
  alt,
  fallback,
  loadingText,
  compact = false,
}: {
  store: FavoriteStore;
  infoHash: string;
  imageId: string;
  alt: string;
  fallback: string;
  loadingText: string;
  compact?: boolean;
}) {
  const key = infoHash + ':' + imageId;
  const [state, setState] = useState<
    | { key: string; status: 'loaded'; url: string }
    | { key: string; status: 'missing' }
    | null
  >(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setState(null);
    void store
      .getAsset(infoHash, imageId)
      .then((blob) => {
        if (!active) return;
        if (!blob) {
          setState({ key, status: 'missing' });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ key, status: 'loaded', url: objectUrl });
      })
      .catch(() => {
        if (active) setState({ key, status: 'missing' });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [store, infoHash, imageId, key]);
  const current = state?.key === key ? state : null;
  const image =
    current?.status === 'loaded' ? (
      <img
        className={compact ? 'favorite-thumbnail' : undefined}
        src={current.url}
        alt={alt}
        onError={() => {
          URL.revokeObjectURL(current.url);
          setState({ key, status: 'missing' });
        }}
      />
    ) : null;
  if (compact) return image;
  return (
    <div className="favorite-image-frame" aria-busy={!current}>
      {image ?? <p className="muted">{current ? fallback : loadingText}</p>}
    </div>
  );
}
