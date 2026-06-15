// Background-runner entry. Bundled by vite.runner.config.ts into a single
// standalone JS asset (dist-runner/runner.js) and loaded by
// @capacitor/background-runner in its sandboxed JS context.
//
// Sandbox notes (verified): NO DOM, NO React, NO persistent in-memory state
// (a fresh context per dispatch). Globals available: console, setTimeout,
// crypto, fetch, TextEncoder/Decoder, CapacitorKV, CapacitorNotifications,
// CapacitorDevice, CapacitorApp. We MUST call resolve()/reject() or the OS
// kills the task. Same pure evaluate() core as the foreground app, so behavior
// and the dedupe ledger are shared.

import type { KV } from '../core/kv';
import { evaluate } from '../core/orchestrator';
import { loadSettings } from '../core/settings';
import type { AlertEvent, Settings } from '../core/types';
import { COINS, COIN_IDS } from '../data/coins';
import { fetchDailyCloses, fetchLivePrice } from '../data/coingecko';
import { publishToNtfy } from '../delivery/ntfy';

// These globals are provided by the background-runner sandbox at runtime.
declare const CapacitorKV: {
  get(key: string): { value: string };
  set(key: string, value: string): void;
  remove(key: string): void;
};
declare const CapacitorNotifications: {
  schedule(notifications: { id: number; title: string; body: string }[]): void;
};
declare function addEventListener(
  event: string,
  handler: (resolve: () => void, reject: (e?: unknown) => void, args: unknown) => void,
): void;

const kvSandbox: KV = {
  async get(key) {
    try {
      const r = CapacitorKV.get(key);
      return r && r.value !== '' ? r.value : null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    CapacitorKV.set(key, value);
  },
  async remove(key) {
    CapacitorKV.remove(key);
  },
};

let notifId = 1;
async function deliver(alert: AlertEvent, settings: Settings): Promise<void> {
  await Promise.allSettled([
    publishToNtfy(settings.ntfyTopic, alert, fetch),
    Promise.resolve(
      CapacitorNotifications.schedule([{ id: notifId++, title: alert.title, body: alert.body }]),
    ),
  ]);
}

addEventListener('evaluate', (resolve, reject) => {
  (async () => {
    const settings = await loadSettings(kvSandbox, COIN_IDS, (n) => {
      const a = new Uint8Array(n);
      crypto.getRandomValues(a);
      return a;
    });
    await evaluate(
      {
        fetchCandles: (coin) => fetchDailyCloses(coin.coingeckoId, fetch),
        fetchLivePrice: (coin) => fetchLivePrice(coin.coingeckoId, fetch),
        kv: kvSandbox,
        deliver,
        now: () => Date.now(),
      },
      COINS,
      settings,
      'background',
    );
  })()
    .then(() => resolve())
    .catch((e) => reject(e));
});
