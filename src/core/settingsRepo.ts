import type { KeyValueStore } from './ports';
import { defaultSettings, normalizeSettings, type Settings } from './settings';

const SETTINGS_KEY = 'settings:v1';

/** Load settings, generating defaults (incl. a fresh ntfy topic) on first run. */
export async function loadSettings(store: KeyValueStore): Promise<Settings> {
  const raw = await store.get(SETTINGS_KEY);
  if (!raw) {
    const fresh = defaultSettings(); // generates "overkill-signals-<random8>"
    await store.set(SETTINGS_KEY, JSON.stringify(fresh));
    return fresh;
  }
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    const fresh = defaultSettings();
    await store.set(SETTINGS_KEY, JSON.stringify(fresh));
    return fresh;
  }
}

export async function saveSettings(store: KeyValueStore, settings: Settings): Promise<void> {
  await store.set(SETTINGS_KEY, JSON.stringify(settings));
}
