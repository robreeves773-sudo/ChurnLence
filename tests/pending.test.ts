import { describe, it, expect, vi } from 'vitest';
import { evaluate } from '../src/core/orchestrator';
import { MemoryKV } from '../src/core/kv';
import { buildCoinState } from '../src/core/signal';
import type { Coin, Settings } from '../src/core/types';
import { buildDailyCandles, crossoverCloses, LAST_CLOSE_DATE, NOW_MS } from './fixtures';

const XRP: Coin = { id: 'xrp', symbol: 'XRP', coingeckoId: 'ripple', displayName: 'XRP', decimals: 4 };
const settings: Settings = {
  ntfyTopic: 'overkill-signals-test1234',
  coinModes: { xrp: 'yellow' },
  quietHours: { startHour: 0, endHour: 0 },
};

describe('intraday-vs-close discipline', () => {
  it('an intraday cross sets pendingFlip and fires NO alert', async () => {
    const flat = buildDailyCandles(crossoverCloses(100, 100), LAST_CLOSE_DATE); // all 100, no close cross
    const deliver = vi.fn(async () => {});
    const result = await evaluate(
      {
        fetchCandles: async () => flat,
        fetchLivePrice: async () => 110, // live price above the EMA
        kv: new MemoryKV(),
        deliver,
        now: () => NOW_MS,
      },
      [XRP],
      settings,
      'foreground',
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(result.fired).toHaveLength(0);
    expect(result.states[0].pendingFlip).not.toBeNull();
    expect(result.states[0].pendingFlip?.direction).toBe('UP');
  });

  it('a completed-close cross confirms and fires exactly one alert', async () => {
    const cross = buildDailyCandles(crossoverCloses(100, 110), LAST_CLOSE_DATE);
    const deliver = vi.fn(async () => {});
    const result = await evaluate(
      { fetchCandles: async () => cross, kv: new MemoryKV(), deliver, now: () => NOW_MS },
      [XRP],
      settings,
      'daily-close',
    );
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0].type).toBe('FLIP');
  });

  it('a reverted intraday move leaves no pending flip', () => {
    const flat = buildDailyCandles(crossoverCloses(100, 100), LAST_CLOSE_DATE);
    const built = buildCoinState('xrp', 'XRP', flat, 100, NOW_MS, NOW_MS);
    expect(built?.state.pendingFlip).toBeNull();
    expect(built?.confirmedFlip).toBeNull();
  });
});
