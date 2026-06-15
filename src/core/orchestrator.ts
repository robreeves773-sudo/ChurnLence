// The single evaluation core. The foreground app, the background runner, and
// the daily-close pass ALL call evaluate() with injected dependencies, so
// behavior is identical everywhere and the shared dedupe ledger prevents
// double-fires. No platform/React/DOM imports here.

import { computeCoinAlerts, computeRegimeAlert } from './alerts';
import { Dedupe } from './dedupe';
import type { KV } from './kv';
import { computeRegime } from './regime';
import { buildCoinState } from './signal';
import { isQuietHour } from './settings';
import type {
  AlertEvent,
  Candle,
  Coin,
  CoinState,
  RegimeState,
  Settings,
} from './types';

const STATES_KEY = 'overkill.states.v1';
const REGIME_KEY = 'overkill.regime.v1';

export type EvalContext = 'foreground' | 'background' | 'daily-close';

export interface EvalDeps {
  /** Completed-or-forming daily candles, ascending by date. */
  fetchCandles: (coin: Coin) => Promise<Candle[]>;
  /** Optional live intraday price (drives pending flips). */
  fetchLivePrice?: (coin: Coin) => Promise<number | null>;
  kv: KV;
  /** Send an accepted alert via ntfy + local notification (both). */
  deliver: (alert: AlertEvent, settings: Settings) => Promise<void>;
  now: () => number;
}

export interface EvalResult {
  context: EvalContext;
  states: CoinState[];
  regime: RegimeState;
  fired: AlertEvent[];
}

export async function evaluate(
  deps: EvalDeps,
  coins: Coin[],
  settings: Settings,
  context: EvalContext,
): Promise<EvalResult> {
  const nowMs = deps.now();
  const dedupe = await Dedupe.load(deps.kv);

  const prevStates = await readStates(deps.kv);
  const prevRegime = await readRegime(deps.kv);

  const states: CoinState[] = [];
  const candidates: AlertEvent[] = [];

  for (const coin of coins) {
    let candles: Candle[];
    try {
      candles = await deps.fetchCandles(coin);
    } catch {
      // Network failure: keep the prior state if we have one (its lastUpdated
      // ages naturally toward the stale threshold).
      const prev = prevStates[coin.id];
      if (prev) states.push(prev);
      continue;
    }
    const live = deps.fetchLivePrice ? await deps.fetchLivePrice(coin).catch(() => null) : null;
    const built = buildCoinState(coin.id, coin.symbol, candles, live, nowMs, nowMs);
    if (!built) continue;

    states.push(built.state);
    const mode = settings.coinModes[coin.id] ?? 'yellow';
    candidates.push(
      ...computeCoinAlerts(coin, built, candles, prevStates[coin.id], mode, nowMs),
    );
  }

  const regime = computeRegime(states);
  const regimeAlert = computeRegimeAlert(prevRegime, regime, nowMs);
  if (regimeAlert) candidates.push(regimeAlert);

  // Gate every candidate: dedupe -> quiet hours -> deliver -> markFired.
  const quiet = isQuietHour(new Date(nowMs), settings.quietHours);
  const fired: AlertEvent[] = [];
  for (const alert of candidates) {
    if (dedupe.hasFired(alert.dedupeKey)) continue;
    if (quiet && !alert.overridesQuietHours) continue; // dropped, not marked
    await deps.deliver(alert, settings);
    await dedupe.markFired(alert.dedupeKey, nowMs);
    fired.push(alert);
  }

  await writeStates(deps.kv, states);
  await writeRegime(deps.kv, regime);

  return { context, states, regime, fired };
}

async function readStates(kv: KV): Promise<Record<string, CoinState>> {
  const raw = await kv.get(STATES_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, CoinState>;
  } catch {
    return {};
  }
}

async function writeStates(kv: KV, states: CoinState[]): Promise<void> {
  const map: Record<string, CoinState> = {};
  for (const s of states) map[s.coinId] = s;
  await kv.set(STATES_KEY, JSON.stringify(map));
}

async function readRegime(kv: KV): Promise<RegimeState | undefined> {
  const raw = await kv.get(REGIME_KEY);
  return raw ? (raw as RegimeState) : undefined;
}

async function writeRegime(kv: KV, regime: RegimeState): Promise<void> {
  await kv.set(REGIME_KEY, regime);
}
