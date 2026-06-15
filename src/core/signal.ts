// Signal engine: derives per-coin state from daily candles and enforces the
// intraday-vs-close discipline. Pure (no I/O).

import { latestEma, ema, latestRsi } from './indicators';
import type { Candle, CoinState, Direction, PendingFlip, Trend, Zone } from './types';

export const YELLOW_BAND_PCT = 2; // ±2% band around the EMA = "YELLOW" zone
export const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const EMA_PERIOD = 200;
export const RSI_PERIOD = 14;

/** UTC calendar date (YYYY-MM-DD) for an epoch-ms instant. */
export function utcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Drop the still-forming candle: a daily candle for UTC date D is only a
 * "completed close" once we are past D's end (i.e. now is on a later UTC date).
 * Candles are assumed ascending by date.
 */
export function completedCandles(candles: Candle[], nowMs: number): Candle[] {
  const today = utcDate(nowMs);
  return candles.filter((c) => c.date < today);
}

function zoneFor(distancePct: number): Zone {
  if (Math.abs(distancePct) <= YELLOW_BAND_PCT) return 'YELLOW';
  return distancePct > 0 ? 'GREEN' : 'RED';
}

function trendFor(price: number, ema200: number): Trend {
  return price >= ema200 ? 'BULLISH' : 'BEARISH';
}

/**
 * Confirmed daily-close flip, derived from the last two COMPLETED closes vs the
 * EMA at each of those points. Intraday price is irrelevant here — this is the
 * canonical signal. Returns the flip direction, or null if no cross.
 */
export function detectConfirmedFlip(closes: number[]): Direction | null {
  const emaSeries = ema(closes, EMA_PERIOD);
  const n = closes.length;
  if (n < 2) return null;
  const prevClose = closes[n - 2];
  const currClose = closes[n - 1];
  const prevEma = emaSeries[n - 2];
  const currEma = emaSeries[n - 1];
  if (prevEma == null || currEma == null) return null;

  if (prevClose <= prevEma && currClose > currEma) return 'UP';
  if (prevClose >= prevEma && currClose < currEma) return 'DOWN';
  return null;
}

/**
 * A pending (intraday) flip: the live price sits on the opposite side of the
 * EMA from the last completed close. This is NOT a signal — it renders as a
 * hollow dot and is only confirmed on the daily-close pass.
 */
export function detectPendingFlip(
  lastClose: number,
  livePrice: number,
  ema200: number,
  nowMs: number,
): PendingFlip | null {
  const closeAbove = lastClose >= ema200;
  const liveAbove = livePrice >= ema200;
  if (closeAbove === liveAbove) return null;
  return {
    direction: liveAbove ? 'UP' : 'DOWN',
    since: new Date(nowMs).toISOString(),
  };
}

export interface BuiltState {
  state: CoinState;
  /** Confirmed flip on the latest completed candle (gate via dedupe to fire once). */
  confirmedFlip: Direction | null;
}

/**
 * Build the full per-coin state from completed candles plus an optional live
 * intraday price. `lastUpdated` is the epoch-ms of the fetch that produced the
 * candles (used for staleness).
 */
export function buildCoinState(
  coinId: string,
  symbol: string,
  candles: Candle[],
  livePrice: number | null,
  lastUpdated: number,
  nowMs: number,
): BuiltState | null {
  const completed = completedCandles(candles, nowMs);
  const closes = completed.map((c) => c.close);
  if (closes.length < EMA_PERIOD) return null; // not enough warmup

  const ema200 = latestEma(closes, EMA_PERIOD);
  if (ema200 == null) return null;
  const rsi = latestRsi(closes, RSI_PERIOD) ?? 50;

  const lastClose = closes[closes.length - 1];
  const lastCloseDate = completed[completed.length - 1].date;
  const price = livePrice ?? lastClose;
  const distancePct = ((price - ema200) / ema200) * 100;

  const state: CoinState = {
    coinId,
    symbol,
    price,
    ema200,
    distancePct,
    zone: zoneFor(distancePct),
    trend: trendFor(price, ema200),
    rsi,
    lastCloseDate,
    lastUpdated,
    stale: nowMs - lastUpdated > STALE_MS,
    pendingFlip:
      livePrice != null ? detectPendingFlip(lastClose, livePrice, ema200, nowMs) : null,
  };

  return { state, confirmedFlip: detectConfirmedFlip(closes) };
}

/** Simple weekly trend arrow: last completed close vs the close ~7 days prior. */
export function weeklyArrow(candles: Candle[], nowMs: number): '↑' | '↓' {
  const completed = completedCandles(candles, nowMs);
  if (completed.length < 8) return '↑';
  const last = completed[completed.length - 1].close;
  const weekAgo = completed[completed.length - 8].close;
  return last >= weekAgo ? '↑' : '↓';
}
