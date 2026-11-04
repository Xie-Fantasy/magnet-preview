import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { GaugeChart } from 'echarts/charts';
import { AriaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { CacheStats } from '../../application/previewCache';
import { createCacheGaugeOption, formatCacheBytes } from './cacheGauge';

echarts.use([GaugeChart, AriaComponent, CanvasRenderer]);

export function CacheGaugeView({
  t,
  stats,
  capBytes,
}: {
  t: (key: string) => string;
  stats: CacheStats;
  capBytes: number | null;
}) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.EChartsType | null>(null);
  const caption =
    capBytes === null
      ? t('cacheCurrentUsage')
      : `${t('cacheGaugeOf')} ${formatCacheBytes(capBytes)}`;
  const accessibilityLabel =
    capBytes === null
      ? `${t('cacheCurrentUsage')}: ${formatCacheBytes(stats.usedBytes)}. ${t('cacheUnlimitedHelp')}`
      : `${t('cacheUsageGauge')}: ${formatCacheBytes(stats.usedBytes)} / ${formatCacheBytes(capBytes)}`;

  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current, undefined, {
      renderer: 'canvas',
    });
    chart.current = instance;
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(element.current);
    return () => {
      resizeObserver.disconnect();
      instance.dispose();
      if (chart.current === instance) chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      const styles = getComputedStyle(document.documentElement);
      instance.setOption({
        ...createCacheGaugeOption({
          usedBytes: stats.usedBytes,
          capBytes,
          colors: {
            accent: styles.getPropertyValue('--accent').trim(),
            ink: styles.getPropertyValue('--ink').trim(),
            line: styles.getPropertyValue('--line').trim(),
          },
          accessibilityLabel,
          caption,
        }),
        animation: !motion.matches,
      });
    };
    update();
    motion.addEventListener('change', update);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      themeObserver.disconnect();
      motion.removeEventListener('change', update);
    };
  }, [accessibilityLabel, capBytes, caption, stats.usedBytes]);

  return (
    <section
      className="cache-gauge-section"
      aria-label={
        capBytes === null ? t('cacheCurrentUsage') : t('cacheUsageGauge')
      }
    >
      <div
        className="cache-gauge"
        ref={element}
        role="img"
        aria-label={accessibilityLabel}
      />
    </section>
  );
}
