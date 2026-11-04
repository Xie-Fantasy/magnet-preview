export type ThemeMode = 'light' | 'dark' | 'system' | 'schedule';
export type ScheduleTimezone = 'local' | 'Asia/Shanghai';
export type ClockTime = `${number}${number}:${number}${number}`;

export interface ThemePreference {
  mode: ThemeMode;
  schedule: {
    darkStart: ClockTime;
    lightStart: ClockTime;
    timezone: ScheduleTimezone;
  };
}

export const defaultTheme: ThemePreference = {
  mode: 'system',
  schedule: { darkStart: '19:00', lightStart: '07:00', timezone: 'local' },
};

function isClockTime(value: unknown): value is ClockTime {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour !== undefined && minute !== undefined && hour < 24 && minute < 60;
}

export function parseThemePreference(value: unknown): ThemePreference {
  if (!value || typeof value !== 'object') return defaultTheme;
  const input = value as Record<string, unknown>;
  const schedule = input.schedule as Record<string, unknown> | undefined;
  if (
    !['light', 'dark', 'system', 'schedule'].includes(String(input.mode)) ||
    !schedule ||
    !isClockTime(schedule.darkStart) ||
    !isClockTime(schedule.lightStart) ||
    !['local', 'Asia/Shanghai'].includes(String(schedule.timezone))
  )
    return defaultTheme;
  return {
    mode: input.mode as ThemeMode,
    schedule: {
      darkStart: schedule.darkStart,
      lightStart: schedule.lightStart,
      timezone: schedule.timezone as ScheduleTimezone,
    },
  };
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
  now = new Date(),
): 'light' | 'dark' {
  if (preference.mode === 'light' || preference.mode === 'dark')
    return preference.mode;
  if (preference.mode === 'system') return systemDark ? 'dark' : 'light';
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone:
      preference.schedule.timezone === 'local' ? undefined : 'Asia/Shanghai',
  }).format(now);
  const { darkStart, lightStart } = preference.schedule;
  if (darkStart === lightStart) return 'light';
  const inDark =
    darkStart > lightStart
      ? time >= darkStart || time < lightStart
      : time >= darkStart && time < lightStart;
  return inDark ? 'dark' : 'light';
}
