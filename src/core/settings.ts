import type { Alert } from './types';
import { COIN_SYMBOLS } from './coins';
import { localHourMinute } from './time';

/** Per-coin alert mode. 'flip' = flips only; 'yellow' = flips + yellow; 'off'. */
export type CoinAlertMode = 'flip' | 'yellow' | 'off';

export interface QuietHours {
  enabled: boolean;
  /** Local start/end in "HH:mm". Wraps past midnight (e.g. 23:00–07:00). */
  start: string;
  end: string;
}

export interface Settings {
  /** ntfy.sh topic the user subscribes to in the ntfy Android app. */
  ntfyTopic: string;
  ntfyServer: string;
  perCoin: Record<string, CoinAlertMode>;
  quietHours: QuietHours;
  /** Minutes offset from UTC for the user's local timezone (for quiet hours). */
  tzOffsetMinutes: number;
}

/** Generate the default topic: "overkill-signals-<random8>". */
export function generateTopic(rand: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return `overkill-signals-${s}`;
}

export function defaultSettings(topic = generateTopic()): Settings {
  const perCoin: Record<string, CoinAlertMode> = {};
  // YELLOW entry default ON => default per-coin mode is 'yellow' (flips + yellow).
  for (const s of COIN_SYMBOLS) perCoin[s] = 'yellow';
  return {
    ntfyTopic: topic,
    ntfyServer: 'https://ntfy.sh',
    perCoin,
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    tzOffsetMinutes: 0
  };
}

function parseHm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** Is `epochMs` within the configured quiet-hours window? */
export function isQuietHours(s: Settings, epochMs: number): boolean {
  if (!s.quietHours.enabled) return false;
  const { h, m } = localHourMinute(epochMs, s.tzOffsetMinutes);
  const now = h * 60 + m;
  const start = parseHm(s.quietHours.start);
  const end = parseHm(s.quietHours.end);
  if (start === end) return false;
  if (start < end) return now >= start && now < end; // same-day window
  return now >= start || now < end; // wraps past midnight
}

/**
 * Decide whether an alert is allowed to fire under the current settings.
 * - Per-coin mode gates flip/yellow alerts (regime/stale are portfolio-wide).
 * - Quiet hours suppress everything EXCEPT signal flips, which always override.
 */
export function isAllowed(s: Settings, alert: Alert, epochMs: number): boolean {
  if (alert.coin) {
    const mode = s.perCoin[alert.coin] ?? 'yellow';
    if (mode === 'off') return false;
    if (alert.type === 'yellow' && mode !== 'yellow') return false;
  }
  if (isQuietHours(s, epochMs) && alert.type !== 'flip') return false;
  return true;
}

export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const base = defaultSettings(raw?.ntfyTopic);
  if (!raw) return base;
  return {
    ntfyTopic: raw.ntfyTopic ?? base.ntfyTopic,
    ntfyServer: raw.ntfyServer ?? base.ntfyServer,
    perCoin: { ...base.perCoin, ...(raw.perCoin ?? {}) },
    quietHours: { ...base.quietHours, ...(raw.quietHours ?? {}) },
    tzOffsetMinutes: raw.tzOffsetMinutes ?? base.tzOffsetMinutes
  };
}
