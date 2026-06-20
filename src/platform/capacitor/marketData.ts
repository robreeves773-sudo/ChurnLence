import type { Candle, CoinFeed } from '../../core/types';
import { COINS, EMA_PERIOD } from '../../core/coins';

/**
 * PUBLIC market-data feed. Reads daily OHLC candles and the latest price from a
 * public, unauthenticated market-data endpoint.
 *
 * This app is ALERT-ONLY. It holds no exchange credentials and reaches no
 * account-scoped or execution endpoints. We only ever READ public candle data.
 *
 * Default source: Binance public klines REST (no auth). Override `baseUrl` /
 * `symbolFor` to point at any other public OHLC source.
 */
export interface MarketDataConfig {
  baseUrl: string;
  /** Map an internal symbol (e.g. "XRP") to the source's pair (e.g. "XRPUSDT"). */
  symbolFor: (symbol: string) => string;
}

export const defaultMarketDataConfig: MarketDataConfig = {
  baseUrl: 'https://api.binance.com/api/v3/klines',
  symbolFor: (symbol) => `${symbol}USDT`
};

/** Fetch ~ (EMA_PERIOD + buffer) daily candles for one coin. */
async function fetchCandles(cfg: MarketDataConfig, symbol: string): Promise<Candle[]> {
  const limit = EMA_PERIOD + 60;
  const url = `${cfg.baseUrl}?symbol=${cfg.symbolFor(symbol)}&interval=1d&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market-data ${symbol}: HTTP ${res.status}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({
    time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4])
  }));
}

/** Fetch feeds for all tracked coins. Offline coins surface with no lastUpdate. */
export async function fetchAllFeeds(
  cfg: MarketDataConfig = defaultMarketDataConfig,
  now: number = Date.now()
): Promise<CoinFeed[]> {
  const results = await Promise.allSettled(COINS.map((c) => fetchCandles(cfg, c.symbol)));
  return COINS.map((c, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.length > 0) {
      const candles = r.value;
      const last = candles[candles.length - 1];
      return {
        symbol: c.symbol,
        candles,
        lastPrice: last.close,
        lastUpdate: now
      };
    }
    // Offline: no candles, no lastUpdate → engine will flag as stale.
    return { symbol: c.symbol, candles: [] };
  });
}
