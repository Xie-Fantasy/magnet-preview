import type { EChartsOption } from 'echarts';
import { formatBytes } from '../../shared/formatBytes';

export interface CacheGaugeColors {
  accent: string;
  ink: string;
  line: string;
}

export function formatCacheBytes(bytes: number): string {
  return formatBytes(bytes);
}

export function cacheGaugePercent(usedBytes: number, capBytes: number): number {
  if (!Number.isFinite(capBytes) || capBytes <= 0) return 0;
  return Math.min(100, Math.max(0, (Math.max(0, usedBytes) / capBytes) * 100));
}

export function createCacheGaugeOption({
  usedBytes,
  capBytes,
  colors,
  accessibilityLabel,
  caption,
}: {
  usedBytes: number;
  capBytes: number | null;
  colors: CacheGaugeColors;
  accessibilityLabel: string;
  caption: string;
}): EChartsOption {
  const finite = capBytes !== null;
  const safeUsedBytes = Math.max(0, Number.isFinite(usedBytes) ? usedBytes : 0);
  return {
    animationDurationUpdate: 180,
    aria: { enabled: true, description: accessibilityLabel },
    series: [
      {
        type: 'gauge',
        center: ['50%', '56%'],
        radius: '78%',
        min: 0,
        max: 100,
        startAngle: 205,
        endAngle: -25,
        pointer: { show: false },
        anchor: { show: false },
        progress: {
          show: finite,
          roundCap: true,
          width: 12,
          itemStyle: { color: colors.accent },
        },
        axisLine: {
          lineStyle: { width: 12, color: [[1, colors.line]] },
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        detail: {
          show: true,
          formatter: formatCacheBytes(safeUsedBytes),
          offsetCenter: [0, '4%'],
          fontSize: 21,
          fontWeight: 650,
          color: colors.ink,
        },
        title: {
          show: true,
          offsetCenter: [0, '33%'],
          fontSize: 12,
          color: colors.ink,
        },
        data: [
          {
            // Unlimited mode uses an unfilled track and an absolute byte
            // label; its zero marker is not a percentage or capacity ratio.
            value:
              capBytes !== null
                ? cacheGaugePercent(safeUsedBytes, capBytes)
                : 0,
            name: caption,
          },
        ],
      },
    ],
  };
}
