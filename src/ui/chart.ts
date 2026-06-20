import type { Candle } from '../core/types';
import { ema as emaSeries } from '../core/ema';

export type DotKind = 'confirmed-buy' | 'confirmed-sell' | 'pending';

export interface DotStyle {
  /** Filled (confirmed) vs hollow (pending). */
  hollow: boolean;
  fill: string;
  stroke: string;
  radius: number;
}

/**
 * Visual style for a chart dot. Confirmed signals are FILLED discs; pending
 * (intraday, unconfirmed) flips are HOLLOW rings — visibly distinct, per the
 * acceptance criteria. This is a pure function so the distinction is testable.
 */
export function dotStyle(kind: DotKind): DotStyle {
  switch (kind) {
    case 'confirmed-buy':
      return { hollow: false, fill: '#10b981', stroke: '#10b981', radius: 5 };
    case 'confirmed-sell':
      return { hollow: false, fill: '#ef4444', stroke: '#ef4444', radius: 5 };
    case 'pending':
      // Hollow: transparent fill, colored ring.
      return { hollow: true, fill: 'transparent', stroke: '#f59e0b', radius: 5 };
  }
}

export interface ChartDot {
  index: number; // candle index
  kind: DotKind;
}

/** Render a coin's price + 200-EMA line with confirmed/pending dots. */
export function renderChart(
  canvas: HTMLCanvasElement,
  candles: Candle[],
  emaPeriod: number,
  dots: ChartDot[]
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || candles.length === 0) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const closes = candles.map((c) => c.close);
  const emaVals = emaSeries(closes, emaPeriod);

  const all = closes.concat(emaVals.filter((v): v is number => v !== null));
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = 8;
  const x = (i: number) => pad + (i / Math.max(1, candles.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / Math.max(1e-12, max - min)) * (H - 2 * pad);

  // Price line.
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  closes.forEach((c, i) => (i === 0 ? ctx.moveTo(x(i), y(c)) : ctx.lineTo(x(i), y(c))));
  ctx.stroke();

  // EMA line.
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  emaVals.forEach((v, i) => {
    if (v === null) return;
    if (!started) {
      ctx.moveTo(x(i), y(v));
      started = true;
    } else ctx.lineTo(x(i), y(v));
  });
  ctx.stroke();

  // Dots.
  for (const dot of dots) {
    const c = candles[dot.index];
    if (!c) continue;
    const s = dotStyle(dot.kind);
    ctx.beginPath();
    ctx.arc(x(dot.index), y(c.close), s.radius, 0, Math.PI * 2);
    if (s.hollow) {
      ctx.fillStyle = '#0b1220';
      ctx.fill(); // punch a hole so the ring reads as hollow over the line
      ctx.lineWidth = 2;
      ctx.strokeStyle = s.stroke;
      ctx.stroke();
    } else {
      ctx.fillStyle = s.fill;
      ctx.fill();
    }
  }
}
