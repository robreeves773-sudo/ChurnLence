import { describe, it, expect } from 'vitest';
import { ema, lastEma } from '../src/core/ema';
import { flat } from './fixtures/candles';

describe('ema', () => {
  it('is null until enough data', () => {
    expect(ema([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it('converges to a constant series', () => {
    expect(lastEma(flat(100, 260), 200)).toBeCloseTo(100, 6);
  });

  it('seeds with the SMA of the first `period` closes', () => {
    const closes = [2, 4, 6, 8]; // SMA of all 4 = 5
    const series = ema(closes, 4);
    expect(series[3]).toBeCloseTo(5, 6);
  });

  it('reacts to a new value via the smoothing factor', () => {
    const closes = flat(100, 200).concat([200]);
    const series = ema(closes, 200);
    const k = 2 / 201;
    expect(series[200]).toBeCloseTo(200 * k + 100 * (1 - k), 6);
  });
});
