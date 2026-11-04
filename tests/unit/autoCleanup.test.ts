import { describe, expect, it, vi } from 'vitest';
import { reconcileAutoCleanupAlarm } from '../../src/application/autoCleanupScheduler';
import { parseAutoCleanupHours } from '../../src/shared/preferences/autoCleanup';

describe('auto-clean interval', () => {
  it('uses the default for missing or invalid versioned settings', () => {
    expect(parseAutoCleanupHours(null)).toBe(24);
    expect(parseAutoCleanupHours({ version: 2, intervalHours: 1 })).toBe(24);
    expect(parseAutoCleanupHours({ version: 1, intervalHours: -1 })).toBe(24);
    expect(parseAutoCleanupHours({ version: 1, intervalHours: 0 })).toBe(0);
    expect(parseAutoCleanupHours({ version: 1, intervalHours: 168 })).toBe(168);
  });

  it('creates, preserves, reschedules, and clears only its own alarm', async () => {
    let current: { periodInMinutes: number } | undefined;
    const get = vi.fn(async () => current as chrome.alarms.Alarm | undefined);
    const create = vi.fn(
      async (_name: string, info: chrome.alarms.AlarmCreateInfo) => {
        current = { periodInMinutes: info.periodInMinutes! };
      },
    );
    const clear = vi.fn(async () => {
      current = undefined;
      return true;
    });
    const alarms = { get, create, clear } as unknown as Pick<
      typeof chrome.alarms,
      'get' | 'create' | 'clear'
    >;
    await reconcileAutoCleanupAlarm(alarms, 24);
    expect(create).toHaveBeenCalledWith('magnetPreview.cacheCleanup', {
      periodInMinutes: 1440,
    });
    await reconcileAutoCleanupAlarm(alarms, 24);
    expect(create).toHaveBeenCalledTimes(1);
    await reconcileAutoCleanupAlarm(alarms, 6);
    expect(create).toHaveBeenLastCalledWith('magnetPreview.cacheCleanup', {
      periodInMinutes: 360,
    });
    await reconcileAutoCleanupAlarm(alarms, 0);
    expect(clear).toHaveBeenCalledWith('magnetPreview.cacheCleanup');
  });
});
