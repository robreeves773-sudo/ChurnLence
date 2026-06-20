import { describe, it, expect } from 'vitest';
import { runEvaluation } from '../src/core/orchestrator';
import { defaultSettings } from '../src/core/settings';
import { COINS } from '../src/core/coins';
import type { CoinFeed } from '../src/core/types';
import { feedFromCloses, flat, BASE_TIME } from './fixtures/candles';
import { FakeStore, CountingNotifier, FixedClock } from './fixtures/fakes';

// Noon UTC (outside the default 23:00–07:00 quiet hours) so regime/yellow
// alerts aren't suppressed by quiet hours during these assertions.
const clock = new FixedClock(BASE_TIME + 300 * 24 * 3600 * 1000 + 12 * 3600 * 1000);

function allFlat(): CoinFeed[] {
  return COINS.map((c) => feedFromCloses(c.symbol, flat(100)));
}

/** Settings with every coin in flip-only mode (no yellow noise from the
 *  flat-at-EMA baseline, which legitimately sits inside the ±2% band). */
function flipOnly() {
  const s = defaultSettings('overkill-signals-test1234');
  for (const c of COINS) s.perCoin[c.symbol] = 'flip';
  return s;
}

describe('runEvaluation (full pass)', () => {
  it('seeds silently, then fires one flip end-to-end and dedupes on re-run', async () => {
    const store = new FakeStore();
    const settings = flipOnly();

    // Pass 1: all coins above EMA → seed, no alerts.
    const seed = await runEvaluation({
      mode: 'close',
      feeds: allFlat(),
      settings,
      store,
      notifier: new CountingNotifier(),
      clock
    });
    expect(seed.delivered).toHaveLength(0);
    expect(seed.regime).toBe('Constructive');

    // Pass 2: XRP crosses below; the other 9 stay above (regime unchanged).
    const feeds = allFlat();
    const xrp = feeds.find((f) => f.symbol === 'XRP')!;
    const crossed = feedFromCloses('XRP', flat(100).concat([80]));
    xrp.candles = crossed.candles;
    xrp.lastPrice = crossed.lastPrice;
    xrp.lastUpdate = crossed.lastUpdate;

    const n2 = new CountingNotifier();
    const run2 = await runEvaluation({ mode: 'close', feeds, settings, store, notifier: n2, clock });
    expect(run2.delivered).toHaveLength(1);
    expect(run2.delivered[0]).toMatchObject({ type: 'flip', coin: 'XRP', direction: 'sell' });
    expect(n2.ntfyPosts).toBe(1);
    expect(n2.localNotifications).toBe(1);

    // Pass 3: identical data → state + dedupe both prevent a repeat.
    const n3 = new CountingNotifier();
    const run3 = await runEvaluation({ mode: 'close', feeds, settings, store, notifier: n3, clock });
    expect(run3.delivered).toHaveLength(0);
  });

  it('fires a regime-change alert when the portfolio banner state changes', async () => {
    const store = new FakeStore();
    const settings = flipOnly();

    // Seed all above → Constructive.
    await runEvaluation({ mode: 'close', feeds: allFlat(), settings, store, notifier: new CountingNotifier(), clock });

    // Flip 6 coins below → Defensive (≤40% above).
    const feeds = allFlat();
    for (const sym of ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'PEPE']) {
      const f = feeds.find((x) => x.symbol === sym)!;
      const crossed = feedFromCloses(sym, flat(100).concat([80]));
      f.candles = crossed.candles;
      f.lastPrice = crossed.lastPrice;
      f.lastUpdate = crossed.lastUpdate;
    }

    const n = new CountingNotifier();
    const run = await runEvaluation({ mode: 'close', feeds, settings, store, notifier: n, clock });
    expect(run.regime).toBe('Defensive');
    const regimeAlerts = run.delivered.filter((a) => a.type === 'regime');
    expect(regimeAlerts).toHaveLength(1);
    expect(regimeAlerts[0].body).toContain('Constructive → Defensive');
  });
});
