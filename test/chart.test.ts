import { describe, it, expect } from 'vitest';
import { dotStyle } from '../src/ui/chart';
import { computeRegime } from '../src/core/regime';

describe('chart dot styles', () => {
  it('renders pending flips as HOLLOW and confirmed signals as FILLED', () => {
    expect(dotStyle('pending').hollow).toBe(true);
    expect(dotStyle('confirmed-buy').hollow).toBe(false);
    expect(dotStyle('confirmed-sell').hollow).toBe(false);
  });

  it('makes the hollow pending dot visibly distinct from confirmed dots', () => {
    const pending = dotStyle('pending');
    const buy = dotStyle('confirmed-buy');
    const sell = dotStyle('confirmed-sell');
    // Distinct fill treatment...
    expect(pending.fill).toBe('transparent');
    expect(buy.fill).not.toBe('transparent');
    expect(sell.fill).not.toBe('transparent');
    // ...and a distinct (amber) ring colour.
    expect(pending.stroke).not.toBe(buy.stroke);
    expect(pending.stroke).not.toBe(sell.stroke);
  });
});

describe('regime', () => {
  it('classifies by share of coins above their EMA', () => {
    const aboveN = (n: number) =>
      Array.from({ length: 10 }, (_, i) => (i < n ? 'above' : 'below')) as ('above' | 'below')[];
    expect(computeRegime(aboveN(6))).toBe('Constructive');
    expect(computeRegime(aboveN(5))).toBe('Mixed');
    expect(computeRegime(aboveN(4))).toBe('Defensive');
  });

  it('ignores coins with unknown side', () => {
    expect(computeRegime([null, null, 'above', 'above'])).toBe('Constructive');
  });
});
