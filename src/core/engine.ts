import type { Alert, Candle, CoinFeed, CoinState, Direction, Side } from './types';
import { emptyCoinState } from './types';
import { ema as emaSeries } from './ema';
import { flipAlert, yellowAlert, staleAlert, type Context } from './messages';
import { utcDate } from './time';

export interface EvaluateOptions {
  /**
   * 'close'    — canonical daily-close evaluation (runs at 00:05 UTC). Confirms
   *              and alerts signal flips.
   * 'intraday' — 60s foreground tick / 15-min background tick. Tracks pending
   *              flips and yellow entries but NEVER confirms a flip.
   */
  mode: 'close' | 'intraday';
  now: number;
  emaPeriod: number;
  bandPct: number;
  staleAfterMs: number;
  /** Optional weekly/RSI context attached to flip messages. */
  context?: Context;
}

/** What the chart needs to render: the EMA line and dot states. */
export interface CoinView {
  symbol: string;
  ema: number | null;
  /** Side of the EMA at the last confirmed close. */
  confirmedSide: Side | null;
  /** A pending (intraday, unconfirmed) flip — rendered as a HOLLOW dot. */
  pendingFlip: { direction: Direction } | null;
  inYellowBand: boolean;
  isStale: boolean;
}

export interface CoinEvaluation {
  alerts: Alert[];
  state: CoinState;
  view: CoinView;
  /** Side of the EMA right now (from last close), used for regime calc. */
  currentSide: Side | null;
}

function sideOf(price: number, emaVal: number): Side {
  // A price essentially equal to the EMA is treated as ABOVE (not below), with a
  // tiny relative tolerance so float noise (e.g. EMA of a flat series landing at
  // 100.0000000000001) never spuriously flips the side.
  return price >= emaVal * (1 - 1e-9) ? 'above' : 'below';
}

function directionFromSide(side: Side): Direction {
  return side === 'above' ? 'buy' : 'sell';
}

/**
 * Evaluate a single coin. Pure: returns new state + any alerts; mutates nothing.
 *
 * Discipline (per Overkill): intraday crosses are NOT signals. They are tracked
 * as a pending flip (hollow dot) and only confirmed + alerted on the daily-close
 * evaluation (`mode: 'close'`). This prevents whipsaw spam on volatile days.
 */
export function evaluateCoin(
  feed: CoinFeed,
  prev: CoinState | undefined,
  opts: EvaluateOptions
): CoinEvaluation {
  const state: CoinState = { ...(prev ?? emptyCoinState()) };
  const alerts: Alert[] = [];

  const closes = feed.candles.map((c: Candle) => c.close);
  const series = emaSeries(closes, opts.emaPeriod);
  const emaVal = series.length ? series[series.length - 1] : null;
  const lastCandle = feed.candles[feed.candles.length - 1];

  // --- STALE DATA (independent of price math) -----------------------------
  let isStale = false;
  if (feed.lastUpdate !== undefined) {
    const age = opts.now - feed.lastUpdate;
    if (age > opts.staleAfterMs) {
      isStale = true;
      if (!state.staleAlerted) {
        alerts.push(
          staleAlert({
            coin: feed.symbol,
            date: utcDate(opts.now),
            hours: age / 3_600_000
          })
        );
        state.staleAlerted = true;
      }
    } else {
      // Feed recovered — re-arm the stale alert for the next episode.
      state.staleAlerted = false;
    }
  }

  // Without an EMA yet (insufficient history) there are no price signals.
  if (emaVal === null || lastCandle === undefined) {
    return {
      alerts,
      state,
      currentSide: null,
      view: {
        symbol: feed.symbol,
        ema: emaVal,
        confirmedSide: state.lastConfirmedSide,
        pendingFlip: state.pendingFlip ? { direction: state.pendingFlip.direction } : null,
        inYellowBand: state.inYellowBand,
        isStale
      }
    };
  }

  // --- SIGNAL FLIP (close mode only) --------------------------------------
  if (opts.mode === 'close') {
    const closeSide = sideOf(lastCandle.close, emaVal);
    const date = utcDate(lastCandle.time);
    if (state.lastConfirmedSide === null) {
      // First-ever evaluation: seed the side, do not alert.
      state.lastConfirmedSide = closeSide;
      state.lastConfirmedDate = date;
    } else if (closeSide !== state.lastConfirmedSide && date !== state.lastConfirmedDate) {
      const direction = directionFromSide(closeSide);
      alerts.push(
        flipAlert({
          coin: feed.symbol,
          direction,
          date,
          close: lastCandle.close,
          ema: emaVal,
          ctx: opts.context
        })
      );
      state.lastConfirmedSide = closeSide;
      state.lastConfirmedDate = date;
    }
    // A close evaluation resolves any pending flip.
    state.pendingFlip = null;
  }

  // --- PENDING FLIP + YELLOW (use live price; fall back to last close) ------
  const livePrice = feed.lastPrice ?? lastCandle.close;
  const liveSide = sideOf(livePrice, emaVal);

  // Pending flip: live price sits on the opposite side of the last confirmed
  // close but has NOT been confirmed by a daily close yet.
  if (state.lastConfirmedSide !== null && liveSide !== state.lastConfirmedSide) {
    const direction = directionFromSide(liveSide);
    if (!state.pendingFlip || state.pendingFlip.direction !== direction) {
      state.pendingFlip = { direction, since: opts.now };
    }
  } else {
    state.pendingFlip = null;
  }

  // Yellow band entry: price moves from OUTSIDE the ±band to INSIDE it.
  const distFrac = Math.abs(livePrice - emaVal) / emaVal;
  const insideBand = distFrac <= opts.bandPct;
  if (insideBand && !state.inYellowBand) {
    alerts.push(
      yellowAlert({
        coin: feed.symbol,
        date: utcDate(opts.now),
        price: livePrice,
        ema: emaVal,
        bandPct: opts.bandPct
      })
    );
  }
  state.inYellowBand = insideBand;

  return {
    alerts,
    state,
    currentSide: sideOf(lastCandle.close, emaVal),
    view: {
      symbol: feed.symbol,
      ema: emaVal,
      confirmedSide: state.lastConfirmedSide,
      pendingFlip: state.pendingFlip ? { direction: state.pendingFlip.direction } : null,
      inYellowBand: state.inYellowBand,
      isStale
    }
  };
}
