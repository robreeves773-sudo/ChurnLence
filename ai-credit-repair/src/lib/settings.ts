import { getDb } from '../db';
import { DEFAULT_MODEL } from '../constants/models';
import type { ModelId, ProfileSettings } from '../types/models';

// Profile + app settings live in the key/value `settings` table.
// (The Anthropic API key is NOT here — it lives in secure-store only.)

const DEFAULTS: ProfileSettings = {
  fullName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  zip: '',
  model: DEFAULT_MODEL,
};

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string | null }>(
    'SELECT value FROM settings WHERE key = ?;',
    [key]
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [key, value]
  );
}

export async function getProfile(): Promise<ProfileSettings> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ key: string; value: string | null }>(
    'SELECT key, value FROM settings;'
  );
  const map = new Map(rows.map((r) => [r.key, r.value ?? '']));
  return {
    fullName: map.get('fullName') ?? DEFAULTS.fullName,
    addressLine1: map.get('addressLine1') ?? DEFAULTS.addressLine1,
    addressLine2: map.get('addressLine2') ?? DEFAULTS.addressLine2,
    city: map.get('city') ?? DEFAULTS.city,
    state: map.get('state') ?? DEFAULTS.state,
    zip: map.get('zip') ?? DEFAULTS.zip,
    model: (map.get('model') as ModelId) || DEFAULTS.model,
  };
}

export async function saveProfile(profile: ProfileSettings): Promise<void> {
  const entries = Object.entries(profile);
  for (const [key, value] of entries) {
    await setSetting(key, String(value ?? ''));
  }
}

export async function getModel(): Promise<ModelId> {
  const value = (await getSetting('model')) as ModelId | null;
  return value || DEFAULT_MODEL;
}
