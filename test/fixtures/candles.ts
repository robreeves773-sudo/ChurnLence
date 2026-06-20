import type { Candle, CoinFeed } from '../../src/core/types';

const DAY = 24 * 60 * 60 * 1000;
/** A fixed UTC-midnight base time so dates are deterministic. */
export const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0, 0); // 2026-01-01

/** Build daily candles from a list of closes (high/low padded around close). */
export function makeCandles(closes: number[], baseTime = BASE_TIME): Candle[] {
  return closes.map((close, i) => ({
    time: baseTime + i * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close
  }));
}

export function feedFromCloses(symbol: string, closes: number[], lastPrice?: number): CoinFeed {
  const candles = makeCandles(closes);
  // lastUpdate intentionally omitted (feed treated as "fresh" — stale detection
  // is exercised explicitly by setting lastUpdate in the relevant test).
  return {
    symbol,
    candles,
    lastPrice: lastPrice ?? candles[candles.length - 1].close
  };
}

/** n constant closes at `price` (EMA converges exactly to `price`). */
export function flat(price: number, n = 260): number[] {
  return new Array(n).fill(price);
}
