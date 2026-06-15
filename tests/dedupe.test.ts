import { describe, it, expect, vi } from 'vitest';
import { evaluate } from '../src/core/orchestrator';
import { MemoryKV } from '../src/core/kv';
import type { Coin, Settings } from '../src/core/types';
import { buildDailyCandles, crossoverCloses, LAST_CLOSE_DATE, NOW_MS } from './fixtures';

const XRP: Coin = { id: 'xrp', symbol: 'XRP', coingeckoId: 'ripple', displayName: 'XRP', decimals: 4 };
const settings: Settings = {
  ntfyTopic: 'overkill-signals-test1234',
  coinModes: { xrp: 'yellow' },
  quietHours: { startHour: 0, endHour: 0 },
};

describe('dedupe survives an app restart', () => {
  it('fires once, then never again from persisted state', async () => {
    const candles = buildDailyCandles(crossoverCloses(100, 110), LAST_CLOSE_DATE);
    const deliver = vi.fn(async () => {});
    const kv = new MemoryKV();

    const first = await evaluate(
      { fetchCandles: async () => candles, kv, deliver, now: () => NOW_MS },
      [XRP],
      settings,
      'daily-close',
    );
    expect(first.fired).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Simulate a full restart: serialize KV, rehydrate a fresh instance.
    const persisted = kv.snapshot();
    const kv2 = new MemoryKV(persisted);
    const deliver2 = vi.fn(async () => {});

    const second = await evaluate(
      { fetchCandles: async () => candles, kv: kv2, deliver: deliver2, now: () => NOW_MS },
      [XRP],
      settings,
      'foreground',
    );
    expect(second.fired).toHaveLength(0); // dedupe held across restart
    expect(deliver2).not.toHaveBeenCalled();
  });
});
