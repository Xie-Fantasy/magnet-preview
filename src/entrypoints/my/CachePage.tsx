import { useEffect, useRef, useState } from 'react';
import {
  defaultCachePolicy,
  type CachePolicy,
  type CacheStats,
  type PreviewCache,
} from '../../application/previewCache';
import { CacheGaugeView } from './CacheGaugeView';
import {
  defaultAutoCleanupHours,
  getAutoCleanupHours,
  setAutoCleanupHours,
  type AutoCleanupHours,
} from '../../shared/preferences/autoCleanup';
import { formatBytes } from '../../shared/formatBytes';

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const STANDARD_TTL_DAYS = [1, 3, 7, 14, 30] as const;
const MIN_CAP_MIB = 1;
const MAX_CAP_MIB = 8192;

function ttlChoiceFor(ttlMs: number | null): string {
  if (ttlMs === null) return 'never';
  const days = ttlMs / DAY;
  return STANDARD_TTL_DAYS.includes(days as (typeof STANDARD_TTL_DAYS)[number])
    ? String(days)
    : 'custom';
}

export function CachePage({
  t,
  cache,
}: {
  t: (key: string) => string;
  cache: PreviewCache;
}) {
  const [policy, setPolicy] = useState<CachePolicy>(defaultCachePolicy);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'saving' | 'error'
  >('loading');
  const [confirmClear, setConfirmClear] = useState(false);
  const [capDraft, setCapDraftState] = useState('512');
  const capDraftRef = useRef('512');
  const lastFiniteCap = useRef(512 * MIB);
  const saving = useRef(false);
  const [ttlChoice, setTtlChoice] = useState('7');
  const [ttlDraft, setTtlDraft] = useState('14');
  const [autoCleanupHours, setAutoCleanupHoursState] =
    useState<AutoCleanupHours>(defaultAutoCleanupHours);

  const setCapDraft = (value: string) => {
    capDraftRef.current = value;
    setCapDraftState(value);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      cache.getPolicy(),
      cache.stats(),
      getAutoCleanupHours(),
    ]).then(
      ([saved, current, cleanupHours]) => {
        if (!active) return;
        setPolicy(saved);
        setTtlChoice(ttlChoiceFor(saved.ttlMs));
        if (saved.ttlMs !== null)
          setTtlDraft(String(Math.round(saved.ttlMs / DAY)));
        if (saved.capBytes !== null) lastFiniteCap.current = saved.capBytes;
        setCapDraft(String(Math.round((saved.capBytes ?? 512 * MIB) / MIB)));
        capDraftRef.current = String(
          Math.round((saved.capBytes ?? 512 * MIB) / MIB),
        );
        setStats(current);
        setAutoCleanupHoursState(cleanupHours);
        setStatus('ready');
      },
      () => {
        if (active) setStatus('error');
      },
    );
    return () => {
      active = false;
    };
  }, [cache]);

  const save = async (next: CachePolicy, nextTtlChoice?: string) => {
    if (saving.current) return;
    saving.current = true;
    setStatus('saving');
    try {
      await cache.setPolicy(next);
      const current = await cache.stats();
      setPolicy(next);
      setTtlChoice(nextTtlChoice ?? ttlChoiceFor(next.ttlMs));
      if (next.ttlMs !== null)
        setTtlDraft(String(Math.round(next.ttlMs / DAY)));
      if (next.capBytes !== null) {
        lastFiniteCap.current = next.capBytes;
        setCapDraft(String(Math.round(next.capBytes / MIB)));
      }
      setStats(current);
      setStatus('ready');
    } catch {
      setStatus('error');
    } finally {
      saving.current = false;
    }
  };

  const saveCleanup = async (hours: AutoCleanupHours) => {
    if (saving.current) return;
    saving.current = true;
    setStatus('saving');
    try {
      await setAutoCleanupHours(hours);
      setAutoCleanupHoursState(hours);
      setStatus('ready');
    } catch {
      setStatus('error');
    } finally {
      saving.current = false;
    }
  };

  const commitCapacityDraft = () => {
    const value = Number(capDraftRef.current);
    if (
      !Number.isSafeInteger(value) ||
      value < MIN_CAP_MIB ||
      value > MAX_CAP_MIB
    ) {
      setCapDraft(
        String(Math.round((policy.capBytes ?? lastFiniteCap.current) / MIB)),
      );
      return;
    }
    const capBytes = value * MIB;
    setCapDraft(String(value));
    if (policy.capBytes === capBytes) return;
    void save({ ...policy, capBytes });
  };

  const clear = async () => {
    setConfirmClear(false);
    setStatus('saving');
    try {
      await cache.clearDisposable();
      setStats(await cache.stats());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  };

  const draftMib = Number(capDraft);
  const gaugeCapBytes =
    policy.capBytes === null
      ? null
      : Number.isSafeInteger(draftMib) &&
          draftMib >= MIN_CAP_MIB &&
          draftMib <= MAX_CAP_MIB
        ? draftMib * MIB
        : policy.capBytes;

  return (
    <div className="cache-settings">
      <p className="muted">{t('cacheDescription')}</p>
      {stats && (
        <>
          <CacheGaugeView t={t} stats={stats} capBytes={gaugeCapBytes} />
          <p role="status" className="cache-stats">
            {t('cachePreviews')}: {stats.previewCount} · {t('cacheImages')}:{' '}
            {stats.screenshotCount} · {t('cacheUsage')}:{' '}
            {formatBytes(stats.usedBytes)}
          </p>
        </>
      )}
      {status === 'error' && <p role="alert">{t('cacheError')}</p>}
      {status === 'loading' && <p role="status">{t('cacheLoading')}</p>}
      {status === 'saving' && <p role="status">{t('cacheSaving')}</p>}
      <fieldset disabled={status === 'loading' || status === 'saving'}>
        <legend>{t('cacheRetention')}</legend>
        <label>
          {t('cacheTtl')}
          <select
            value={ttlChoice}
            onChange={(event) => {
              const choice = event.target.value;
              setTtlChoice(choice);
              if (choice === 'never') {
                void save({ ...policy, ttlMs: null }, 'never');
              } else if (choice !== 'custom') {
                void save({ ...policy, ttlMs: Number(choice) * DAY }, choice);
              }
            }}
          >
            <option value="1">{t('cacheOneDay')}</option>
            <option value="3">{t('cacheThreeDays')}</option>
            <option value="7">{t('cacheSevenDays')}</option>
            <option value="14">{t('cacheFourteenDays')}</option>
            <option value="30">{t('cacheThirtyDays')}</option>
            <option value="custom">{t('cacheCustomDays')}</option>
            <option value="never">{t('cacheNeverExpire')}</option>
          </select>
        </label>
        {ttlChoice === 'custom' && (
          <label>
            {t('cacheCustomTtl')}
            <input
              type="number"
              min="1"
              max="3650"
              step="1"
              value={ttlDraft}
              onChange={(event) => setTtlDraft(event.target.value)}
              onBlur={() => {
                const days = Number(ttlDraft);
                if (Number.isSafeInteger(days) && days >= 1 && days <= 3650)
                  void save({ ...policy, ttlMs: days * DAY }, 'custom');
                else
                  setTtlDraft(
                    String(Math.round((policy.ttlMs ?? 14 * DAY) / DAY)),
                  );
              }}
            />
          </label>
        )}
        <label>
          {t('cacheAutoCleanup')}
          <select
            value={autoCleanupHours}
            onChange={(event) =>
              void saveCleanup(Number(event.target.value) as AutoCleanupHours)
            }
          >
            <option value={0}>{t('cacheAutoOff')}</option>
            <option value={1}>{t('cacheAutoHourly')}</option>
            <option value={6}>{t('cacheAutoSixHours')}</option>
            <option value={24}>{t('cacheAutoDaily')}</option>
            <option value={168}>{t('cacheAutoWeekly')}</option>
          </select>
        </label>
        <p className="muted">{t('cacheAutoCleanupHelp')}</p>
        <label>
          {t('cacheCapacityMode')}
          <select
            value={policy.capBytes === null ? 'unlimited' : 'limited'}
            onChange={(event) => {
              if (event.target.value === 'unlimited') {
                if (policy.capBytes !== null)
                  lastFiniteCap.current = policy.capBytes;
                void save({ ...policy, capBytes: null });
              } else {
                void save({
                  ...policy,
                  capBytes: lastFiniteCap.current,
                });
              }
            }}
          >
            <option value="limited">{t('cacheLimited')}</option>
            <option value="unlimited">{t('cacheUnlimited')}</option>
          </select>
        </label>
        {policy.capBytes !== null && (
          <>
            <label>
              {t('cacheLimitMib')}
              <input
                type="number"
                min={MIN_CAP_MIB}
                max={MAX_CAP_MIB}
                step="1"
                value={capDraft}
                onChange={(event) => setCapDraft(event.target.value)}
                onBlur={commitCapacityDraft}
              />
            </label>
            <label>
              {t('cacheCapacitySlider')}
              <input
                type="range"
                min={MIN_CAP_MIB}
                max={MAX_CAP_MIB}
                step="1"
                value={
                  Number.isSafeInteger(draftMib) &&
                  draftMib >= MIN_CAP_MIB &&
                  draftMib <= MAX_CAP_MIB
                    ? draftMib
                    : Math.round(policy.capBytes / MIB)
                }
                onChange={(event) => setCapDraft(event.target.value)}
                onPointerUp={commitCapacityDraft}
                onKeyUp={commitCapacityDraft}
                onBlur={commitCapacityDraft}
              />
            </label>
          </>
        )}
      </fieldset>
      <p className="muted">{t('cacheUnlimitedHelp')}</p>
      {confirmClear ? (
        <div className="cache-clear-confirm">
          <p>{t('cacheClearConfirm')}</p>
          <button className="destructive-action" onClick={() => void clear()}>
            {t('cacheClearNow')}
          </button>
          <button onClick={() => setConfirmClear(false)}>
            {t('cacheCancel')}
          </button>
        </div>
      ) : (
        <button
          className="destructive-action"
          disabled={status === 'saving' || status === 'loading'}
          onClick={() => setConfirmClear(true)}
        >
          {t('cacheClear')}
        </button>
      )}
    </div>
  );
}
