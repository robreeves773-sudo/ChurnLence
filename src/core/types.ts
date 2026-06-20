/**
 * Core domain types for the Overkill signal engine.
 *
 * Everything in `src/core` is platform-agnostic and side-effect free so it can
 * be unit-tested in plain Node. Platform concerns (Capacitor Preferences,
 * LocalNotifications, network) are injected via the ports in `./ports`.
 */

/** A daily OHLC candle. `time` is the candle-open epoch (ms, UTC midnight). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Live feed for one coin: the closed daily candles plus the current tick. */
export interface CoinFeed {
  symbol: string;
  /** Closed daily candles, ascending by time. The last entry is the most
   *  recently CLOSED daily candle. */
  candles: Candle[];
  /** Latest intraday price (may be undefined if feed is offline). */
  lastPrice?: number;
  /** Epoch ms of the last successful feed update. */
  lastUpdate?: number;
}

/** Which side of the 200-EMA a price sits on. */
export type Side = 'above' | 'below';

/** A confirmed-signal direction. BUY = crossed above, SELL = crossed below. */
export type Direction = 'buy' | 'sell';

export type AlertType = 'flip' | 'yellow' | 'regime' | 'stale';

export type Priority = 'high' | 'default';

/** Portfolio-level regime derived from how many coins sit above their EMA. */
export type Regime = 'Defensive' | 'Mixed' | 'Constructive';

/**
 * Per-coin persisted signal state. Survives app restarts so dedupe and the
 * intraday/close discipline behave consistently across process death.
 */
export interface CoinState {
  /** Side of the EMA at the last CONFIRMED daily close. null until first eval. */
  lastConfirmedSide: Side | null;
  /** Date (UTC YYYY-MM-DD) of the candle that produced lastConfirmedSide. */
  lastConfirmedDate: string | null;
  /** Intraday "pending flip" not yet confirmed by a daily close, or null. */
  pendingFlip: { direction: Direction; since: number } | null;
  /** Whether the live price currently sits inside the ±band around the EMA. */
  inYellowBand: boolean;
  /** True once a stale-data alert has fired for the current offline episode. */
  staleAlerted: boolean;
}

/** A fully-formed alert ready to be deduped and dispatched. */
export interface Alert {
  type: AlertType;
  coin?: string;
  direction?: Direction;
  /** UTC date (YYYY-MM-DD) the alert pertains to. */
  date: string;
  title: string;
  body: string;
  priority: Priority;
  /** Stable key used for once-per dedupe in persistent storage. */
  dedupeKey: string;
}

export function emptyCoinState(): CoinState {
  return {
    lastConfirmedSide: null,
    lastConfirmedDate: null,
    pendingFlip: null,
    inYellowBand: false,
    staleAlerted: false
  };
}
