// KV implemented over Capacitor Preferences (durable on device; localStorage on
// web). Used by the foreground app.

import { Preferences } from '@capacitor/preferences';
import type { KV } from '../core/kv';

export const preferencesKv: KV = {
  async get(key) {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  },
  async set(key, value) {
    await Preferences.set({ key, value });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
};

/** crypto-backed random bytes for the default ntfy topic suffix. */
export function getRandomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}
