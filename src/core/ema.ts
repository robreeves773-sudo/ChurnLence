/**
 * Exponential Moving Average.
 *
 * Seeded with a simple moving average of the first `period` closes (the
 * conventional EMA seed), then rolled forward. Returns an array aligned with
 * `closes`; entries before enough data exists are `null`.
 */
export function ema(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return out;

  const k = 2 / (period + 1);

  // Seed: SMA of the first `period` closes.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** The most recent EMA value (or null if insufficient data). */
export function lastEma(closes: number[], period: number): number | null {
  const series = ema(closes, period);
  return series.length ? series[series.length - 1] : null;
}
