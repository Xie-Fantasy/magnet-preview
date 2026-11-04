export const AUTO_CLEANUP_KEY = 'magnetPreview.autoCleanup.v1';
export const AUTO_CLEANUP_ALARM = 'magnetPreview.cacheCleanup';
export type AutoCleanupHours = 0 | 1 | 6 | 24 | 168;
export const defaultAutoCleanupHours: AutoCleanupHours = 24;

export function parseAutoCleanupHours(value: unknown): AutoCleanupHours {
  if (!value || typeof value !== 'object') return defaultAutoCleanupHours;
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    ![0, 1, 6, 24, 168].includes(input.intervalHours as number)
  )
    return defaultAutoCleanupHours;
  return input.intervalHours as AutoCleanupHours;
}

export async function getAutoCleanupHours(): Promise<AutoCleanupHours> {
  const stored = await chrome.storage.local.get(AUTO_CLEANUP_KEY);
  return parseAutoCleanupHours(stored[AUTO_CLEANUP_KEY]);
}

export async function setAutoCleanupHours(
  hours: AutoCleanupHours,
): Promise<void> {
  if (![0, 1, 6, 24, 168].includes(hours))
    throw new Error('Invalid auto-clean interval');
  await chrome.storage.local.set({
    [AUTO_CLEANUP_KEY]: { version: 1, intervalHours: hours },
  });
}
