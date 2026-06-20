import type { KeyValueStore } from './ports';

/**
 * Persistent dedupe. Each alert carries a stable `dedupeKey`
 * (e.g. `flip:XRP:2026-06-11:buy`). Once marked, it never fires again — and
 * because it lives in the KeyValueStore (Capacitor Preferences in production),
 * the dedupe survives app restarts, exactly as the acceptance criteria require.
 */
export class DedupeStore {
  readonly #store: KeyValueStore;
  readonly #prefix: string;

  constructor(store: KeyValueStore, prefix = 'dedupe:') {
    this.#store = store;
    this.#prefix = prefix;
  }

  async seen(key: string): Promise<boolean> {
    return (await this.#store.get(this.#prefix + key)) !== null;
  }

  async mark(key: string): Promise<void> {
    await this.#store.set(this.#prefix + key, '1');
  }
}
