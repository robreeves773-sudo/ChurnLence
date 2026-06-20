import { Preferences } from '@capacitor/preferences';
import type { KeyValueStore } from '../../core/ports';

/** KeyValueStore backed by Capacitor Preferences (persists across restarts). */
export const preferencesStore: KeyValueStore = {
  async get(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key });
    return value;
  },
  async set(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  },
  async remove(key: string): Promise<void> {
    await Preferences.remove({ key });
  }
};
