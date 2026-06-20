import { describe, it, expect } from 'vitest';
import { flipAlert, yellowAlert, regimeAlert, staleAlert, fmtPrice, fmtPct } from '../src/core/messages';

describe('formatting', () => {
  it('formats prices without scientific notation for tiny coins', () => {
    expect(fmtPrice(2.41)).toBe('$2.41');
    expect(fmtPrice(0.0000012)).toBe('$0.0000012');
  });
  it('formats signed percentages', () => {
    expect(fmtPct(0.021)).toBe('+2.1%');
    expect(fmtPct(-0.004)).toBe('-0.4%');
  });
});

describe('flipAlert', () => {
  it('builds the spec title/body and a high priority, stable dedupe key', () => {
    const a = flipAlert({
      coin: 'XRP',
      direction: 'buy',
      date: '2026-06-11',
      close: 2.41,
      ema: 2.36,
      ctx: { weeklyUp: true, rsi: 58 }
    });
    expect(a.title).toBe('BUY SIGNAL: XRP');
    expect(a.body).toContain('Daily close $2.41 crossed ABOVE 200 EMA ($2.36, +2.1%).');
    expect(a.body).toContain('W:↑ RSI 58.');
    expect(a.body).toContain('2026-06-11.');
    expect(a.priority).toBe('high');
    expect(a.dedupeKey).toBe('flip:XRP:2026-06-11:buy');
  });

  it('uses BELOW wording for sell flips', () => {
    const a = flipAlert({ coin: 'PEPE', direction: 'sell', date: '2026-06-11', close: 0.0000009, ema: 0.000001 });
    expect(a.title).toBe('SELL SIGNAL: PEPE');
    expect(a.body).toContain('crossed BELOW 200 EMA');
  });
});

describe('other alerts', () => {
  it('yellow entries are default priority', () => {
    const a = yellowAlert({ coin: 'ETH', date: '2026-06-11', price: 101, ema: 100, bandPct: 0.02 });
    expect(a.priority).toBe('default');
    expect(a.dedupeKey).toBe('yellow:ETH:2026-06-11');
  });
  it('regime alert names the transition', () => {
    const a = regimeAlert({ from: 'Mixed', to: 'Constructive', date: '2026-06-11' });
    expect(a.body).toContain('Mixed → Constructive');
  });
  it('stale alert is high priority', () => {
    const a = staleAlert({ coin: 'SOL', date: '2026-06-11', hours: 3.2 });
    expect(a.priority).toBe('high');
    expect(a.dedupeKey).toBe('stale:SOL:2026-06-11');
  });
});
