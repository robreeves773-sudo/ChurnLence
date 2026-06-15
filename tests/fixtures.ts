// Deterministic candle fixtures for the alert tests.

import type { Candle } from '../src/core/types';

/** Build daily candles from a close series, dated consecutively and ending on
 *  `lastDate` (UTC, YYYY-MM-DD). Earliest close maps to the earliest date. */
export function buildDailyCandles(closes: number[], lastDate: string): Candle[] {
  const end = new Date(`${lastDate}T00:00:00Z`).getTime();
  const day = 24 * 60 * 60 * 1000;
  return closes.map((close, i) => {
    const offset = (closes.length - 1 - i) * day;
    const date = new Date(end - offset).toISOString().slice(0, 10);
    return { date, close };
  });
}

/** 220 closes flat at `flat`, with the final completed close jumping to `last`
 *  — a clean confirmed crossover when last/flat straddle the (flat) EMA. */
export function crossoverCloses(flat: number, last: number, n = 220): number[] {
  const arr = new Array(n - 1).fill(flat);
  arr.push(last);
  return arr;
}

/** A fixed "now": 2026-06-11 12:00 UTC. Last completed candle = 2026-06-10. */
export const NOW_MS = new Date('2026-06-11T12:00:00Z').getTime();
export const LAST_CLOSE_DATE = '2026-06-10';
