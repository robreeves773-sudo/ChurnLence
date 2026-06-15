// CoinGecko public (keyless) data client. READ-ONLY market data.
//
// We use /market_chart for DAILY CLOSES (keyless tier returns daily-spaced
// points for days>90), which is exactly what the 200-EMA strategy needs, and
// /ohlc for the chart's candles (coarser on the free tier — documented
// tradeoff). There are NO API keys, NO auth headers, NO trade endpoints here.

import type { Candle } from '../core/types';

const BASE = 'https://api.coingecko.com/api/v3';

type FetchFn = typeof fetch;

function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Daily closes for the last ~365 days as Candle[] (close only), ascending.
 * One point per UTC day (later points within a day overwrite earlier ones).
 */
export async function fetchDailyCloses(
  coingeckoId: string,
  doFetch: FetchFn = fetch,
  days = 365,
): Promise<Candle[]> {
  const url = `${BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetchWithRetry(url, doFetch);
  const json = (await res.json()) as { prices: [number, number][] };
  const byDate = new Map<string, number>();
  for (const [ts, price] of json.prices) {
    byDate.set(utcDateOf(ts), price);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, close]) => ({ date, close }));
}

/** Coarse OHLC candles for charting (keyless tier ≈ 4-day candles for long ranges). */
export async function fetchOhlc(
  coingeckoId: string,
  doFetch: FetchFn = fetch,
  days = 365,
): Promise<Candle[]> {
  const url = `${BASE}/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetchWithRetry(url, doFetch);
  const json = (await res.json()) as [number, number, number, number, number][];
  return json.map(([ts, open, high, low, close]) => ({
    date: utcDateOf(ts),
    open,
    high,
    low,
    close,
  }));
}

/** Current spot price (drives intraday pending-flip detection). */
export async function fetchLivePrice(
  coingeckoId: string,
  doFetch: FetchFn = fetch,
): Promise<number | null> {
  const url = `${BASE}/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
  const res = await fetchWithRetry(url, doFetch);
  const json = (await res.json()) as Record<string, { usd: number }>;
  return json[coingeckoId]?.usd ?? null;
}

async function fetchWithRetry(url: string, doFetch: FetchFn, retries = 1): Promise<Response> {
  const res = await doFetch(url);
  if (res.status === 429 && retries > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    return fetchWithRetry(url, doFetch, retries - 1);
  }
  if (!res.ok) throw new Error(`CoinGecko ${res.status} for ${url}`);
  return res;
}
