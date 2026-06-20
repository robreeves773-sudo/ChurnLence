import { describe, it, expect } from 'vitest';
import { evaluateCoin } from '../src/core/engine';
import { dispatchAlerts } from '../src/core/dispatcher';
import { DedupeStore } from '../src/core/dedupe';
import { emptyCoinState } from '../src/core/types';
import { defaultSettings } from '../src/core/settings';
import { feedFromCloses, flat, BASE_TIME } from './fixtures/candles';
import { FakeStore, CountingNotifier } from './fixtures/fakes';

const NOW = BASE_TIME + 300 * 24 * 3600 * 1000;
const EVAL = { mode: 'close' as const, now: NOW, emaPeriod: 200, bandPct: 0.02, staleAfterMs: 2 * 3600 * 1000 };

describe('acceptance: simulated crossover', () => {
  it('produces exactly ONE ntfy POST and ONE local notification', async () => {
    const store = new FakeStore();
    const notifier = new CountingNotifier();
    const settings = defaultSettings('overkill-signals-test1234');

    // XRP: 260 closes at 100 (above EMA), then one close at 80 (below) → SELL flip.
    const feed = feedFromCloses('XRP', flat(100).concat([80]));
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const, lastConfirmedDate: '2026-01-01' };

    const r = evaluateCoin(feed, seeded, EVAL);
    const delivered = await dispatchAlerts({
      alerts: r.alerts,
      settings,
      dedupe: new DedupeStore(store),
      notifier,
      now: NOW
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe('flip');
    expect(delivered[0].direction).toBe('sell');
    expect(notifier.ntfyPosts).toBe(1); // exactly one ntfy POST
    expect(notifier.localNotifications).toBe(1); // exactly one local notification
  });

  it('dedupe survives app restart (persisted store)', async () => {
    const store = new FakeStore();
    const settings = defaultSettings('overkill-signals-test1234');
    const feed = feedFromCloses('XRP', flat(100).concat([80]));
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const, lastConfirmedDate: '2026-01-01' };
    const r = evaluateCoin(feed, seeded, EVAL);

    // First launch: fires once.
    const n1 = new CountingNotifier();
    const d1 = await dispatchAlerts({ alerts: r.alerts, settings, dedupe: new DedupeStore(store), notifier: n1, now: NOW });
    expect(d1).toHaveLength(1);

    // Simulate restart: brand-new store object over the SAME backing data.
    const restarted = new FakeStore(store.map);
    const n2 = new CountingNotifier();
    const d2 = await dispatchAlerts({ alerts: r.alerts, settings, dedupe: new DedupeStore(restarted), notifier: n2, now: NOW });
    expect(d2).toHaveLength(0);
    expect(n2.ntfyPosts).toBe(0);
    expect(n2.localNotifications).toBe(0);
  });
});
