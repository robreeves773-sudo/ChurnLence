import { describe, it, expect, vi } from 'vitest';
import { evaluate } from '../src/core/orchestrator';
import { MemoryKV } from '../src/core/kv';
import type { Coin, Settings } from '../src/core/types';
import { buildDailyCandles, crossoverCloses, LAST_CLOSE_DATE, NOW_MS } from './fixtures';

const XRP: Coin = { id: 'xrp', symbol: 'XRP', coingeckoId: 'ripple', displayName: 'XRP', decimals: 4 };

// A quiet window that definitely covers NOW_MS in the test runner's local TZ.
const localHour = new Date(NOW_MS).getHours();
const QUIET = { startHour: localHour, endHour: (localHour + 1) % 24 };
const OPEN = { startHour: 0, endHour: 0 };

function withQuiet(quiet: { startHour: number; endHour: number }): Settings {
  return { ntfyTopic: 'overkill-signals-test1234', coinModes: { xrp: 'yellow' }, quietHours: quiet };
}

// Seed a prior GREEN state so a move into the ±2% band is a fresh YELLOW entry.
function seededKv(): MemoryKV {
  const prior = {
    xrp: {
      coinId: 'xrp',
      symbol: 'XRP',
      price: 105,
      ema200: 100,
      distancePct: 5,
      zone: 'GREEN',
      trend: 'BULLISH',
      rsi: 55,
      lastCloseDate: '2026-06-09',
      lastUpdated: NOW_MS,
      stale: false,
      pendingFlip: null,
    },
  };
  const kv = new MemoryKV();
  kv.store['overkill.states.v1'] = JSON.stringify(prior);
  return kv;
}

describe('quiet hours', () => {
  it('a SIGNAL FLIP breaks through quiet hours', async () => {
    const candles = buildDailyCandles(crossoverCloses(100, 110), LAST_CLOSE_DATE);
    const deliver = vi.fn(async () => {});
    const result = await evaluate(
      { fetchCandles: async () => candles, kv: new MemoryKV(), deliver, now: () => NOW_MS },
      [XRP],
      withQuiet(QUIET),
      'daily-close',
    );
    expect(result.fired.some((a) => a.type === 'FLIP')).toBe(true);
  });

  it('a YELLOW entry is suppressed during quiet hours but delivers outside them', async () => {
    const flat = buildDailyCandles(crossoverCloses(100, 100), LAST_CLOSE_DATE); // price==EMA -> YELLOW

    const suppressed = await evaluate(
      { fetchCandles: async () => flat, kv: seededKv(), deliver: vi.fn(async () => {}), now: () => NOW_MS },
      [XRP],
      withQuiet(QUIET),
      'foreground',
    );
    expect(suppressed.fired.some((a) => a.type === 'YELLOW')).toBe(false);

    const delivered = await evaluate(
      { fetchCandles: async () => flat, kv: seededKv(), deliver: vi.fn(async () => {}), now: () => NOW_MS },
      [XRP],
      withQuiet(OPEN),
      'foreground',
    );
    expect(delivered.fired.some((a) => a.type === 'YELLOW')).toBe(true);
  });
});
