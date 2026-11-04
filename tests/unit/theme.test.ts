import { describe, expect, it } from 'vitest';
import {
  defaultTheme,
  parseThemePreference,
  resolveTheme,
} from '../../src/shared/preferences/theme';

describe('theme preference', () => {
  it('resolves light, dark, and system', () => {
    expect(resolveTheme({ ...defaultTheme, mode: 'light' }, true)).toBe(
      'light',
    );
    expect(resolveTheme({ ...defaultTheme, mode: 'dark' }, false)).toBe('dark');
    expect(resolveTheme(defaultTheme, true)).toBe('dark');
    expect(resolveTheme(defaultTheme, false)).toBe('light');
  });
  it('parses the scheduled model with both timezone choices', () => {
    for (const timezone of ['local', 'Asia/Shanghai'] as const) {
      const value = {
        mode: 'schedule',
        schedule: { darkStart: '19:00', lightStart: '07:00', timezone },
      };
      expect(parseThemePreference(value)).toEqual(value);
    }
    expect(
      parseThemePreference({
        mode: 'schedule',
        schedule: { darkStart: '25:00' },
      }),
    ).toEqual(defaultTheme);
    expect(
      resolveTheme(
        {
          ...defaultTheme,
          mode: 'schedule',
          schedule: { ...defaultTheme.schedule, timezone: 'Asia/Shanghai' },
        },
        false,
        new Date('2026-01-01T12:00:00Z'),
      ),
    ).toBe('dark');
  });
});
