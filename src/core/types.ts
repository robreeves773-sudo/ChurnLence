// Pure domain types — NO React, NO DOM, NO Capacitor imports.
// This module (and everything it transitively imports) must run unchanged in
// the background-runner sandbox, in the foreground app, and under Vitest.

export type Direction = 'UP' | 'DOWN';
export type Zone = 'GREEN' | 'YELLOW' | 'RED';
export type Trend = 'BULLISH' | 'BEARISH';
export type RegimeState = 'Defensive' | 'Mixed' | 'Constructive';

/** A single daily candle. OHLC are optional because the keyless CoinGecko
 *  `market_chart` close feed only carries the close; the chart's coarser OHLC
 *  feed fills the rest. `date` is the UTC calendar date `YYYY-MM-DD`. */
export interface Candle {
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

export interface Coin {
  id: string; // internal stable id, e.g. "xrp"
  symbol: string; // display ticker, e.g. "XRP"
  coingeckoId: string; // CoinGecko id, e.g. "ripple"
  displayName: string;
  decimals: number; // price display precision (PEPE needs many)
}

/** A pending intraday flip — the live price is on the opposite side of the EMA
 *  but the daily candle has NOT closed yet, so this is NOT a signal. Rendered
 *  as a hollow dot and only confirmed on the daily-close pass. */
export interface PendingFlip {
  direction: Direction;
  since: string; // ISO timestamp when the intraday cross was first observed
}

export interface CoinState {
  coinId: string;
  symbol: string;
  price: number; // latest known price (live last, or last completed close)
  ema200: number;
  distancePct: number; // (price - ema200) / ema200 * 100
  zone: Zone;
  trend: Trend;
  rsi: number;
  lastCloseDate: string; // date of the last COMPLETED daily candle
  lastUpdated: number; // epoch ms of last successful data fetch
  stale: boolean; // lastUpdated older than the staleness threshold
  pendingFlip: PendingFlip | null;
}

export type AlertType = 'FLIP' | 'YELLOW' | 'REGIME' | 'STALE';
export type Priority = 'default' | 'high';

export interface AlertEvent {
  type: AlertType;
  coinId?: string; // absent for REGIME
  /** Stable de-duplication key, e.g. "flip:xrp:2026-06-11:UP". */
  dedupeKey: string;
  title: string;
  body: string;
  priority: Priority;
  /** Signal flips override quiet hours; other alert types are suppressed. */
  overridesQuietHours: boolean;
}

/** Per-coin alert preference. */
export type CoinAlertMode = 'flip' | 'yellow' | 'off';

export interface QuietHours {
  startHour: number; // local hour 0-23 inclusive
  endHour: number; // local hour 0-23 exclusive
}

export interface Settings {
  ntfyTopic: string;
  coinModes: Record<string, CoinAlertMode>;
  quietHours: QuietHours;
}
