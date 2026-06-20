import type { Alert, Direction, Regime } from './types';

/** Pretty price: avoid scientific notation for sub-cent coins like PEPE. */
export function fmtPrice(v: number): string {
  if (v === 0) return '$0';
  const abs = Math.abs(v);
  let decimals: number;
  if (abs >= 1) decimals = 2;
  else if (abs >= 0.01) decimals = 4;
  else decimals = 8;
  return '$' + v.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** Signed percentage, e.g. +2.1% / -0.4%. */
export function fmtPct(frac: number): string {
  const pct = frac * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function dirWord(d: Direction): string {
  return d === 'buy' ? 'ABOVE' : 'BELOW';
}

/**
 * Optional weekly-trend / RSI context line, kept short for notification bodies.
 * `weeklyUp` is the weekly trend arrow; `rsi` is the 14-period daily RSI.
 */
export interface Context {
  weeklyUp?: boolean;
  rsi?: number;
}

function contextSuffix(ctx?: Context): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.weeklyUp !== undefined) parts.push(`W:${ctx.weeklyUp ? '↑' : '↓'}`);
  if (ctx.rsi !== undefined) parts.push(`RSI ${Math.round(ctx.rsi)}`);
  return parts.length ? ' ' + parts.join(' ') + '.' : '';
}

/** SIGNAL FLIP — the core alert. */
export function flipAlert(args: {
  coin: string;
  direction: Direction;
  date: string;
  close: number;
  ema: number;
  ctx?: Context;
}): Alert {
  const { coin, direction, date, close, ema, ctx } = args;
  const pctVsEma = (close - ema) / ema;
  const title = `${direction === 'buy' ? 'BUY' : 'SELL'} SIGNAL: ${coin}`;
  const body =
    `Daily close ${fmtPrice(close)} crossed ${dirWord(direction)} 200 EMA ` +
    `(${fmtPrice(ema)}, ${fmtPct(pctVsEma)}).${contextSuffix(ctx)} ${date}.`;
  return {
    type: 'flip',
    coin,
    direction,
    date,
    title,
    body,
    priority: 'high', // signal flips are always high priority
    dedupeKey: `flip:${coin}:${date}:${direction}`
  };
}

/** YELLOW ENTRY — early warning that a flip may be coming. */
export function yellowAlert(args: {
  coin: string;
  date: string;
  price: number;
  ema: number;
  bandPct: number;
}): Alert {
  const { coin, date, price, ema, bandPct } = args;
  const pctVsEma = (price - ema) / ema;
  const title = `YELLOW: ${coin} near 200 EMA`;
  const body =
    `${coin} ${fmtPrice(price)} entered the ±${(bandPct * 100).toFixed(0)}% band ` +
    `around 200 EMA (${fmtPrice(ema)}, ${fmtPct(pctVsEma)}). Possible flip. ${date}.`;
  return {
    type: 'yellow',
    coin,
    date,
    title,
    body,
    priority: 'default', // YELLOW-zone entries are default priority
    dedupeKey: `yellow:${coin}:${date}`
  };
}

/** REGIME CHANGE — portfolio banner state change. */
export function regimeAlert(args: { from: Regime; to: Regime; date: string }): Alert {
  const { from, to, date } = args;
  return {
    type: 'regime',
    date,
    title: `REGIME: ${to}`,
    body: `Portfolio regime changed ${from} → ${to}. ${date}.`,
    priority: 'high',
    dedupeKey: `regime:${date}:${to}`
  };
}

/** STALE DATA — a dead feed means missed signals. */
export function staleAlert(args: { coin: string; date: string; hours: number }): Alert {
  const { coin, date, hours } = args;
  return {
    type: 'stale',
    coin,
    date,
    title: `STALE FEED: ${coin}`,
    body: `${coin} feed has been offline ${hours.toFixed(1)}h — signals may be missed. ${date}.`,
    priority: 'high',
    dedupeKey: `stale:${coin}:${date}`
  };
}
