import { describe, expect, it } from 'vitest';
import {
  cacheGaugePercent,
  createCacheGaugeOption,
  formatCacheBytes,
} from '../../src/entrypoints/my/cacheGauge';

const colors = { accent: '#175d9d', ink: '#17212b', line: '#c7d1da' };

function gauge(option: ReturnType<typeof createCacheGaugeOption>) {
  const series = Array.isArray(option.series)
    ? option.series[0]
    : option.series;
  return series as {
    data: Array<{ value: number; name?: string }>;
    detail: { show: boolean };
    progress: { show: boolean };
    title: { show: boolean };
  };
}

describe('cache usage gauge', () => {
  it('maps finite capacity to bounded percentages, including zero and near-full', () => {
    expect(cacheGaugePercent(0, 512)).toBe(0);
    expect(cacheGaugePercent(256, 512)).toBe(50);
    expect(cacheGaugePercent(511, 512)).toBeCloseTo(99.8);
    expect(cacheGaugePercent(600, 512)).toBe(100);
    expect(cacheGaugePercent(100, 0)).toBe(0);
  });

  it('keeps the long byte ratio outside the chart arc', () => {
    const option = createCacheGaugeOption({
      usedBytes: 348 * 1024 * 1024,
      capBytes: 512 * 1024 * 1024,
      colors,
      accessibilityLabel: 'Capacity used: 348 MiB / 512 MiB',
      caption: 'of 512 MiB',
    });
    const series = gauge(option);
    expect(series.data[0]?.value).toBeCloseTo((348 / 512) * 100);
    expect(series.progress.show).toBe(true);
    expect(series.detail.show).toBe(true);
    expect(series.title.show).toBe(true);
    expect(series.data[0]?.name).toBe('of 512 MiB');
  });

  it('uses an unfilled unlimited presentation with absolute bytes and no ratio', () => {
    const option = createCacheGaugeOption({
      usedBytes: 348 * 1024 * 1024,
      capBytes: null,
      colors,
      accessibilityLabel: 'Current cache usage: 348 MiB. No extension limit.',
      caption: 'Current cache usage',
    });
    const series = gauge(option);
    expect(series.data[0]?.value).toBe(0);
    expect(series.progress.show).toBe(false);
    expect(series.detail.show).toBe(true);
    expect(series.title.show).toBe(true);
    expect(series.data[0]?.name).toBe('Current cache usage');
    expect(option.aria).toMatchObject({ enabled: true });
    expect(JSON.stringify(option.aria)).not.toContain('∞');
  });

  it('formats small byte counts without negative or non-finite output', () => {
    expect(formatCacheBytes(0)).toBe('0 B');
    expect(formatCacheBytes(1536)).toBe('1.50 KiB');
    expect(formatCacheBytes(-1)).toBe('0 B');
    expect(formatCacheBytes(Number.NaN)).toBe('0 B');
  });
});
