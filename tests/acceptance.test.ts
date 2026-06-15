import { describe, it, expect, vi } from 'vitest';
import { evaluate } from '../src/core/orchestrator';
import { MemoryKV } from '../src/core/kv';
import { publishToNtfy } from '../src/delivery/ntfy';
import type { AlertEvent, Coin, Settings } from '../src/core/types';
import { buildDailyCandles, crossoverCloses, LAST_CLOSE_DATE, NOW_MS } from './fixtures';

const XRP: Coin = {
  id: 'xrp',
  symbol: 'XRP',
  coingeckoId: 'ripple',
  displayName: 'XRP',
  decimals: 4,
};

function settings(): Settings {
  return {
    ntfyTopic: 'overkill-signals-test1234',
    coinModes: { xrp: 'yellow' },
    quietHours: { startHour: 0, endHour: 0 }, // never quiet
  };
}

describe('acceptance: a simulated crossover produces exactly ONE ntfy POST and ONE local notification', () => {
  it('fires a single BUY SIGNAL through both delivery paths', async () => {
    const candles = buildDailyCandles(crossoverCloses(100, 110), LAST_CLOSE_DATE);
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const localSpy = vi.fn(async () => {});

    const deliver = async (alert: AlertEvent, s: Settings) => {
      await publishToNtfy(s.ntfyTopic, alert, fetchSpy as unknown as typeof fetch);
      await localSpy();
    };

    const result = await evaluate(
      {
        fetchCandles: async () => candles,
        kv: new MemoryKV(),
        deliver,
        now: () => NOW_MS,
      },
      [XRP],
      settings(),
      'daily-close',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1); // exactly ONE ntfy POST
    expect(localSpy).toHaveBeenCalledTimes(1); // exactly ONE local notification
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0].type).toBe('FLIP');
    expect(result.fired[0].title).toBe('BUY SIGNAL: XRP');
    expect(result.fired[0].body).toContain('crossed ABOVE 200 EMA');
    expect(result.fired[0].body).toContain(LAST_CLOSE_DATE);

    // Verify the real ntfy POST shape (method + high priority for a flip).
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Priority).toBe('4');
  });
});
