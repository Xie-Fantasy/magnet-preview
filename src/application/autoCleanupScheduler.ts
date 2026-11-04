import {
  AUTO_CLEANUP_ALARM,
  type AutoCleanupHours,
} from '../shared/preferences/autoCleanup';

export async function reconcileAutoCleanupAlarm(
  alarms: Pick<typeof chrome.alarms, 'get' | 'create' | 'clear'>,
  hours: AutoCleanupHours,
): Promise<void> {
  const current = await alarms.get(AUTO_CLEANUP_ALARM);
  if (hours === 0) {
    if (current) await alarms.clear(AUTO_CLEANUP_ALARM);
    return;
  }
  const periodInMinutes = hours * 60;
  if (current?.periodInMinutes === periodInMinutes) return;
  await alarms.create(AUTO_CLEANUP_ALARM, { periodInMinutes });
}
