import type { Alert, CoinFeed, CoinState, Regime, Side } from './types';
import { emptyCoinState } from './types';
import type { KeyValueStore, Notifier, Clock } from './ports';
import { systemClock } from './ports';
import type { Settings } from './settings';
import { EMA_PERIOD, YELLOW_BAND_PCT, STALE_AFTER_MS } from './coins';
import { evaluateCoin, type CoinView, type EvaluateOptions } from './engine';
import { computeRegime } from './regime';
import { regimeAlert } from './messages';
import { DedupeStore } from './dedupe';
import { dispatchAlerts } from './dispatcher';
import { utcDate } from './time';

const STATE_PREFIX = 'state:';
const REGIME_KEY = 'regime:last';

async function loadState(store: KeyValueStore, symbol: string): Promise<CoinState | undefined> {
  const raw = await store.get(STATE_PREFIX + symbol);
  if (!raw) return undefined;
  try {
    return { ...emptyCoinState(), ...(JSON.parse(raw) as Partial<CoinState>) };
  } catch {
    return undefined;
  }
}

async function saveState(store: KeyValueStore, symbol: string, state: CoinState): Promise<void> {
  await store.set(STATE_PREFIX + symbol, JSON.stringify(state));
}

export interface EvaluationRun {
  delivered: Alert[];
  views: CoinView[];
  regime: Regime;
}

/**
 * Run one full evaluation pass across all coins in `feeds`.
 *
 * Used by every cadence: the 60s foreground tick (`mode: 'intraday'`), the
 * 15-min background WorkManager tick (`mode: 'intraday'`), and the canonical
 * 00:05 UTC daily-close check (`mode: 'close'`).
 */
export async function runEvaluation(args: {
  mode: 'close' | 'intraday';
  feeds: CoinFeed[];
  settings: Settings;
  store: KeyValueStore;
  notifier: Notifier;
  clock?: Clock;
  emaPeriod?: number;
  bandPct?: number;
  staleAfterMs?: number;
}): Promise<EvaluationRun> {
  const clock = args.clock ?? systemClock;
  const now = clock.now();
  const opts: EvaluateOptions = {
    mode: args.mode,
    now,
    emaPeriod: args.emaPeriod ?? EMA_PERIOD,
    bandPct: args.bandPct ?? YELLOW_BAND_PCT,
    staleAfterMs: args.staleAfterMs ?? STALE_AFTER_MS
  };

  const dedupe = new DedupeStore(args.store);
  const views: CoinView[] = [];
  const sides: (Side | null)[] = [];
  const allAlerts: Alert[] = [];

  for (const feed of args.feeds) {
    const prev = await loadState(args.store, feed.symbol);
    const result = evaluateCoin(feed, prev, opts);
    await saveState(args.store, feed.symbol, result.state);
    views.push(result.view);
    sides.push(result.currentSide);
    allAlerts.push(...result.alerts);
  }

  // --- REGIME CHANGE (portfolio-wide) -------------------------------------
  const regime = computeRegime(sides);
  const prevRegime = (await args.store.get(REGIME_KEY)) as Regime | null;
  if (prevRegime && prevRegime !== regime) {
    allAlerts.push(regimeAlert({ from: prevRegime, to: regime, date: utcDate(now) }));
  }
  await args.store.set(REGIME_KEY, regime);

  const delivered = await dispatchAlerts({
    alerts: allAlerts,
    settings: args.settings,
    dedupe,
    notifier: args.notifier,
    now
  });

  return { delivered, views, regime };
}
