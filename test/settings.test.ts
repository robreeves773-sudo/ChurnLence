import { describe, it, expect } from 'vitest';
import { defaultSettings, generateTopic, isQuietHours, isAllowed, normalizeSettings } from '../src/core/settings';
import type { Alert } from '../src/core/types';

const at = (h: number, m = 0) => Date.UTC(2026, 5, 20, h, m, 0, 0);

function alert(over: Partial<Alert>): Alert {
  return { type: 'flip', date: '2026-06-20', title: 't', body: 'b', priority: 'high', dedupeKey: 'k', ...over };
}

describe('topic generation', () => {
  it('matches overkill-signals-<random8>', () => {
    let i = 0;
    const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const topic = generateTopic(() => seq[i++]);
    expect(topic).toMatch(/^overkill-signals-[a-z0-9]{8}$/);
  });
});

describe('quiet hours', () => {
  const s = defaultSettings('overkill-signals-test1234'); // 23:00–07:00, tz 0

  it('wraps past midnight', () => {
    expect(isQuietHours(s, at(23, 30))).toBe(true);
    expect(isQuietHours(s, at(2))).toBe(true);
    expect(isQuietHours(s, at(6, 59))).toBe(true);
    expect(isQuietHours(s, at(7, 1))).toBe(false);
    expect(isQuietHours(s, at(12))).toBe(false);
  });

  it('respects the timezone offset', () => {
    const tz = { ...s, tzOffsetMinutes: 60 }; // local = UTC+1
    // 22:30 UTC → 23:30 local → quiet.
    expect(isQuietHours(tz, at(22, 30))).toBe(true);
  });
});

describe('isAllowed', () => {
  const s = defaultSettings('overkill-signals-test1234');

  it('signal flips override quiet hours', () => {
    expect(isAllowed(s, alert({ type: 'flip', coin: 'BTC' }), at(2))).toBe(true);
  });

  it('non-flip alerts are suppressed during quiet hours', () => {
    expect(isAllowed(s, alert({ type: 'yellow', coin: 'BTC', priority: 'default' }), at(2))).toBe(false);
    expect(isAllowed(s, alert({ type: 'yellow', coin: 'BTC', priority: 'default' }), at(12))).toBe(true);
  });

  it('per-coin "off" silences that coin', () => {
    const off = { ...s, perCoin: { ...s.perCoin, BTC: 'off' as const } };
    expect(isAllowed(off, alert({ type: 'flip', coin: 'BTC' }), at(12))).toBe(false);
  });

  it('per-coin "flip" mode drops yellow but keeps flips', () => {
    const flipOnly = { ...s, perCoin: { ...s.perCoin, BTC: 'flip' as const } };
    expect(isAllowed(flipOnly, alert({ type: 'yellow', coin: 'BTC', priority: 'default' }), at(12))).toBe(false);
    expect(isAllowed(flipOnly, alert({ type: 'flip', coin: 'BTC' }), at(12))).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it('fills defaults and merges per-coin overrides', () => {
    const s = normalizeSettings({ perCoin: { BTC: 'off' } });
    expect(s.perCoin.BTC).toBe('off');
    expect(s.perCoin.ETH).toBe('yellow');
    expect(s.quietHours.enabled).toBe(true);
  });
});
