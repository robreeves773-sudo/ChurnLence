// Turns state diffs into candidate AlertEvents. Pure — it does NOT dedupe,
// check quiet hours, or deliver; the orchestrator does that. Candidates may be
// emitted repeatedly (e.g. a confirmed flip persists until the next candle);
// the dedupe ledger guarantees each fires at most once.

import {
  buildFlipMessage,
  buildRegimeMessage,
  buildStaleMessage,
  buildYellowMessage,
} from './format';
import { STALE_MS, utcDate, weeklyArrow } from './signal';
import type { BuiltState } from './signal';
import type { AlertEvent, Candle, Coin, CoinAlertMode, CoinState, RegimeState } from './types';

export function computeCoinAlerts(
  coin: Coin,
  built: BuiltState,
  candles: Candle[],
  prevState: CoinState | undefined,
  mode: CoinAlertMode,
  nowMs: number,
): AlertEvent[] {
  if (mode === 'off') return [];
  const out: AlertEvent[] = [];
  const s = built.state;

  // 1. SIGNAL FLIP — confirmed daily-close cross. Both 'flip' and 'yellow' modes
  //    receive flips (flip is the core alert; yellow is flip + early warning).
  if (built.confirmedFlip) {
    const dir = built.confirmedFlip;
    const msg = buildFlipMessage(
      coin.symbol,
      dir,
      s.price,
      s.ema200,
      s.distancePct,
      weeklyArrow(candles, nowMs),
      s.rsi,
      s.lastCloseDate,
      coin.decimals,
    );
    out.push({
      type: 'FLIP',
      coinId: coin.id,
      dedupeKey: `flip:${coin.id}:${s.lastCloseDate}:${dir}`,
      title: msg.title,
      body: msg.body,
      priority: 'high',
      overridesQuietHours: true,
    });
  }

  // 2. YELLOW ENTRY — price enters the ±2% band from outside it.
  if (mode === 'yellow' && s.zone === 'YELLOW' && prevState && prevState.zone !== 'YELLOW') {
    const msg = buildYellowMessage(s, coin.decimals);
    out.push({
      type: 'YELLOW',
      coinId: coin.id,
      dedupeKey: `yellow:${coin.id}:${utcDate(nowMs)}`,
      title: msg.title,
      body: msg.body,
      priority: 'default',
      overridesQuietHours: false,
    });
  }

  // 4. STALE DATA — feed offline > 2h. Keyed by lastUpdated so it fires once per
  //    outage and re-arms when fresh data (new lastUpdated) arrives.
  if (s.stale) {
    const hours = Math.floor((nowMs - s.lastUpdated) / (60 * 60 * 1000)) || Math.floor(STALE_MS / 3600000);
    const msg = buildStaleMessage(coin.symbol, hours);
    out.push({
      type: 'STALE',
      coinId: coin.id,
      dedupeKey: `stale:${coin.id}:${s.lastUpdated}`,
      title: msg.title,
      body: msg.body,
      priority: 'default',
      overridesQuietHours: false,
    });
  }

  return out;
}

// 3. REGIME CHANGE — portfolio banner state transition.
export function computeRegimeAlert(
  prev: RegimeState | undefined,
  next: RegimeState,
  nowMs: number,
): AlertEvent | null {
  if (!prev || prev === next) return null;
  const msg = buildRegimeMessage(next);
  return {
    type: 'REGIME',
    dedupeKey: `regime:${next}:${utcDate(nowMs)}`,
    title: msg.title,
    body: msg.body,
    priority: 'default',
    overridesQuietHours: false,
  };
}
