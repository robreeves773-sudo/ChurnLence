// Settings load/save + first-run defaults. Persisted in KV.

import type { KV } from './kv';
import type { CoinAlertMode, Settings } from './types';

const SETTINGS_KEY = 'overkill.settings.v1';

/** 8-char lowercase-alnum suffix for the default ntfy topic. */
export function randomTopicSuffix(getRandom: (n: number) => Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = getRandom(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function defaultSettings(coinIds: string[], topicSuffix: string): Settings {
  const coinModes: Record<string, CoinAlertMode> = {};
  for (const id of coinIds) coinModes[id] = 'yellow'; // yellow default ON (includes flips)
  return {
    ntfyTopic: `overkill-signals-${topicSuffix}`,
    coinModes,
    quietHours: { startHour: 23, endHour: 7 },
  };
}

export async function loadSettings(
  kv: KV,
  coinIds: string[],
  getRandom: (n: number) => Uint8Array,
): Promise<Settings> {
  const raw = await kv.get(SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Settings;
      // Ensure newly-added coins get a default mode.
      for (const id of coinIds) {
        if (!(id in parsed.coinModes)) parsed.coinModes[id] = 'yellow';
      }
      return parsed;
    } catch {
      /* fall through to fresh defaults */
    }
  }
  const fresh = defaultSettings(coinIds, randomTopicSuffix(getRandom));
  await saveSettings(kv, fresh);
  return fresh;
}

export async function saveSettings(kv: KV, settings: Settings): Promise<void> {
  await kv.set(SETTINGS_KEY, JSON.stringify(settings));
}

/** Local-time quiet-hours check; handles windows that wrap past midnight. */
export function isQuietHour(date: Date, quiet: { startHour: number; endHour: number }): boolean {
  const h = date.getHours();
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  // wraps midnight, e.g. 23 -> 7
  return h >= startHour || h < endHour;
}
