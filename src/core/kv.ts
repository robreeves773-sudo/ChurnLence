// Minimal async key-value interface. Implemented over Capacitor Preferences in
// the app, over CapacitorKV in the background-runner sandbox, and over a plain
// Map in tests. Pure interface — no platform imports here.

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory KV — used by tests and as a fallback. Its `store` can be
 *  serialized/rehydrated to simulate an app restart. */
export class MemoryKV implements KV {
  constructor(public store: Record<string, string> = {}) {}
  async get(key: string): Promise<string | null> {
    return key in this.store ? this.store[key] : null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store[key] = value;
  }
  async remove(key: string): Promise<void> {
    delete this.store[key];
  }
  snapshot(): Record<string, string> {
    return JSON.parse(JSON.stringify(this.store));
  }
}
