import { describe, it, expect } from 'vitest';
import { evaluateCoin } from '../src/core/engine';
import { emptyCoinState } from '../src/core/types';
import { feedFromCloses, flat, BASE_TIME } from './fixtures/candles';

const OPTS = {
  emaPeriod: 200,
  bandPct: 0.02,
  staleAfterMs: 2 * 60 * 60 * 1000,
  now: BASE_TIME + 300 * 24 * 3600 * 1000
};

describe('evaluateCoin — close discipline', () => {
  it('seeds side on first close eval without alerting', () => {
    // lastPrice 110 sits clearly above the EMA (outside the ±2% yellow band) so
    // this isolates the seeding behaviour from any yellow-entry alert.
    const feed = feedFromCloses('BTC', flat(100), 110);
    const r = evaluateCoin(feed, undefined, { ...OPTS, mode: 'close' });
    expect(r.alerts).toHaveLength(0);
    expect(r.state.lastConfirmedSide).toBe('above');
  });

  it('emits exactly ONE flip alert on a confirmed close crossover', () => {
    // 260 candles at 100 (EMA≈100, above), then a candle closing at 80 (below).
    const feed = feedFromCloses('XRP', flat(100).concat([80]));
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const, lastConfirmedDate: '2026-01-01' };
    const r = evaluateCoin(feed, seeded, { ...OPTS, mode: 'close' });
    const flips = r.alerts.filter((a) => a.type === 'flip');
    expect(flips).toHaveLength(1);
    expect(flips[0].direction).toBe('sell');
    expect(r.state.lastConfirmedSide).toBe('below');
  });

  it('does NOT confirm a flip in intraday mode (no whipsaw spam)', () => {
    const feed = feedFromCloses('PEPE', flat(100), /* lastPrice */ 80);
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const, lastConfirmedDate: '2026-01-01' };
    const r = evaluateCoin(feed, seeded, { ...OPTS, mode: 'intraday' });
    expect(r.alerts.filter((a) => a.type === 'flip')).toHaveLength(0);
    // ...but it IS tracked as a pending flip (hollow dot).
    expect(r.view.pendingFlip).toEqual({ direction: 'sell' });
  });
});

describe('evaluateCoin — yellow band', () => {
  it('alerts when price enters the ±2% band from outside', () => {
    // EMA≈100; price 101 is within 2%. Previous state was outside the band.
    const feed = feedFromCloses('ETH', flat(100), 101);
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const, inYellowBand: false };
    const r = evaluateCoin(feed, seeded, { ...OPTS, mode: 'intraday' });
    const yellow = r.alerts.filter((a) => a.type === 'yellow');
    expect(yellow).toHaveLength(1);
    expect(r.state.inYellowBand).toBe(true);
  });

  it('does not re-alert yellow while still inside the band', () => {
    const feed = feedFromCloses('ETH', flat(100), 101);
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const, inYellowBand: true };
    const r = evaluateCoin(feed, seeded, { ...OPTS, mode: 'intraday' });
    expect(r.alerts.filter((a) => a.type === 'yellow')).toHaveLength(0);
  });
});

describe('evaluateCoin — stale data', () => {
  it('alerts once when a feed is offline > 2h, then re-arms on recovery', () => {
    const stale = feedFromCloses('SOL', flat(100));
    stale.lastUpdate = OPTS.now - 3 * 3600 * 1000; // 3h old
    const seeded = { ...emptyCoinState(), lastConfirmedSide: 'above' as const };
    const r1 = evaluateCoin(stale, seeded, { ...OPTS, mode: 'intraday' });
    expect(r1.alerts.filter((a) => a.type === 'stale')).toHaveLength(1);

    // Second pass while still stale → no repeat.
    const r2 = evaluateCoin(stale, r1.state, { ...OPTS, mode: 'intraday' });
    expect(r2.alerts.filter((a) => a.type === 'stale')).toHaveLength(0);

    // Feed recovers, then goes stale again → alerts again.
    const fresh = { ...stale, lastUpdate: OPTS.now };
    const r3 = evaluateCoin(fresh, r2.state, { ...OPTS, mode: 'intraday' });
    expect(r3.state.staleAlerted).toBe(false);
    const r4 = evaluateCoin(stale, r3.state, { ...OPTS, mode: 'intraday' });
    expect(r4.alerts.filter((a) => a.type === 'stale')).toHaveLength(1);
  });
});
