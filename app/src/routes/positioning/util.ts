/**
 * Small helpers shared by the Positioning findings: reading design tokens into
 * JS (so canvas/ECharts match the CSS theme), reacting to a light/dark switch,
 * a reduced-motion check, and a leak-safe ECharts lifecycle hook.
 */
import { useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import * as echarts from 'echarts';

export interface Tokens {
  accent: string; accent2: string; hot: string; warn: string;
  ink: string; ink2: string; ink3: string; panel: string; panel2: string; rule: string;
}

/** Read the current CSS custom properties so a chart drawn to canvas matches the theme. */
export function readTokens(): Tokens {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    accent: v('--accent'), accent2: v('--accent-2'), hot: v('--hot'), warn: v('--warn'),
    ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'),
    panel: v('--panel'), panel2: v('--panel-2'), rule: v('--rule'),
  };
}

/** A counter that ticks when the OS light/dark preference flips, to re-theme charts. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => setV((x) => x + 1);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return v;
}

export const prefersReduced = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Mount an ECharts instance into a div and keep it correct: (re)build on data or
 * theme change, resize with the container, dispose on unmount. StrictMode-safe
 * because every effect run creates then disposes its own instance.
 */
export function useChart(
  build: (chart: echarts.ECharts, tokens: Tokens) => void,
  deps: DependencyList,
) {
  const ref = useRef<HTMLDivElement>(null);
  const themeV = useThemeVersion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    build(chart, readTokens());
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => { ro.disconnect(); chart.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, themeV]);
  return ref;
}

/** n of N as a rounded percent, e.g. pct(20,182) -> "11%". */
export const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : '—');
