import { describe, it, expect } from 'vitest';
import { buildFlipMessage, formatPrice, formatSignedPct } from '../src/core/format';
import { ema, latestEma, rsi } from '../src/core/indicators';

describe('message formatting matches the v1.3 spec exactly', () => {
  it('formats the canonical XRP BUY signal body', () => {
    const msg = buildFlipMessage('XRP', 'UP', 2.41, 2.36, 2.1, '↑', 58, '2026-06-11', 2);
    expect(msg.title).toBe('BUY SIGNAL: XRP');
    expect(msg.body).toBe(
      'Daily close $2.41 crossed ABOVE 200 EMA ($2.36, +2.1%). W:↑ RSI 58. 2026-06-11.',
    );
  });

  it('renders sub-cent coins (PEPE) without rounding to zero', () => {
    expect(formatPrice(0.00000275, 9)).toBe('$0.000002750');
  });

  it('signs percentages', () => {
    expect(formatSignedPct(2.1)).toBe('+2.1%');
    expect(formatSignedPct(-3.2)).toBe('-3.2%');
  });
});

describe('indicators', () => {
  it('EMA seeds with SMA and tracks toward new values', () => {
    const series = ema([1, 2, 3, 4, 5], 3);
    expect(series[0]).toBeNull();
    expect(series[1]).toBeNull();
    expect(series[2]).toBeCloseTo(2); // SMA of 1,2,3
    expect(latestEma([1, 2, 3, 4, 5], 3)).toBeGreaterThan(3);
  });

  it('RSI is 100 when only gains occur after warmup', () => {
    const closes = [...new Array(20).fill(100), 110];
    const series = rsi(closes, 14);
    expect(series[series.length - 1]).toBe(100);
  });
});
