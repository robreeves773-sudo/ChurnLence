// Durable de-duplication ledger. Persisted in KV (Preferences / CapacitorKV) so
// a fired alert stays fired across app restarts AND across the foreground /
// background / daily-close execution contexts. This is what makes "exactly ONE
// ntfy POST + ONE local notification per crossover" hold by construction.

import type { KV } from './kv';

const LEDGER_KEY = 'overkill.dedupe.v1';
const PRUNE_AFTER_DAYS = 14;

type Ledger = Record<string, number>; // dedupeKey -> epoch ms when fired

export class Dedupe {
  private constructor(
    private kv: KV,
    private ledger: Ledger,
  ) {}

  static async load(kv: KV): Promise<Dedupe> {
    const raw = await kv.get(LEDGER_KEY);
    let ledger: Ledger = {};
    if (raw) {
      try {
        ledger = JSON.parse(raw) as Ledger;
      } catch {
        ledger = {};
      }
    }
    return new Dedupe(kv, ledger);
  }

  hasFired(key: string): boolean {
    return key in this.ledger;
  }

  /** Record a key as fired and persist immediately. */
  async markFired(key: string, nowMs: number): Promise<void> {
    this.ledger[key] = nowMs;
    this.prune(nowMs);
    await this.kv.set(LEDGER_KEY, JSON.stringify(this.ledger));
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    for (const [k, t] of Object.entries(this.ledger)) {
      if (t < cutoff) delete this.ledger[k];
    }
  }
}
