// Message formatting for alerts. Pure. Produces the EXACT strings required by
// the v1.3 spec, decimal-aware so PEPE renders as $0.000002750.

import type { CoinState, Direction, RegimeState } from './types';

export function formatPrice(value: number, decimals: number): string {
  return `$${value.toFixed(decimals)}`;
}

export function formatSignedPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export interface FlipMessage {
  title: string;
  body: string;
}

/**
 * SIGNAL FLIP message.
 *   Title: "BUY SIGNAL: XRP" / "SELL SIGNAL: PEPE"
 *   Body:  "Daily close $2.41 crossed ABOVE 200 EMA ($2.36, +2.1%). W:↑ RSI 58. 2026-06-11."
 */
export function buildFlipMessage(
  symbol: string,
  direction: Direction,
  closePrice: number,
  ema200: number,
  distancePct: number,
  weekly: '↑' | '↓',
  rsi: number,
  closeDate: string,
  decimals: number,
): FlipMessage {
  const action = direction === 'UP' ? 'BUY' : 'SELL';
  const aboveBelow = direction === 'UP' ? 'ABOVE' : 'BELOW';
  return {
    title: `${action} SIGNAL: ${symbol}`,
    body:
      `Daily close ${formatPrice(closePrice, decimals)} crossed ${aboveBelow} 200 EMA ` +
      `(${formatPrice(ema200, decimals)}, ${formatSignedPct(distancePct)}). ` +
      `W:${weekly} RSI ${Math.round(rsi)}. ${closeDate}.`,
  };
}

/** YELLOW ENTRY message (early warning a flip may be coming). */
export function buildYellowMessage(state: CoinState, decimals: number): FlipMessage {
  return {
    title: `YELLOW ZONE: ${state.symbol}`,
    body:
      `${formatPrice(state.price, decimals)} entered ±${2}% band of 200 EMA ` +
      `(${formatPrice(state.ema200, decimals)}, ${formatSignedPct(state.distancePct)}). ` +
      `RSI ${Math.round(state.rsi)}.`,
  };
}

export function buildRegimeMessage(state: RegimeState): FlipMessage {
  return {
    title: `REGIME: ${state}`,
    body: `Portfolio regime changed to ${state}.`,
  };
}

export function buildStaleMessage(symbol: string, hours: number): FlipMessage {
  return {
    title: `STALE DATA: ${symbol}`,
    body: `${symbol} feed has been offline for ~${hours}h — signals may be missed.`,
  };
}
