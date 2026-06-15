// Pure technical indicators. Side-effect free and fully unit-tested.

/**
 * Exponential Moving Average series.
 * Seeded with the SMA of the first `period` values, then
 * EMA_t = price_t * k + EMA_{t-1} * (1 - k), with k = 2 / (period + 1).
 *
 * Returns an array aligned to `values`; entries before the seed index are
 * `null` (insufficient warmup). For EMA(200) you need >= 200 values; we fetch
 * ~365 daily closes so the result is well warmed up.
 */
export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error('ema: period must be > 0');
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Latest (last non-null) EMA value, or null if not enough data. */
export function latestEma(values: number[], period: number): number | null {
  const series = ema(values, period);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

/**
 * Relative Strength Index using Wilder's smoothing.
 * Returns an array aligned to `values`; entries before warmup are `null`.
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

export function latestRsi(values: number[], period = 14): number | null {
  const series = rsi(values, period);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
