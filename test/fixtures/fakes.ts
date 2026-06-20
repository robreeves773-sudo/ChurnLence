import type { KeyValueStore, Notifier, Clock } from '../../src/core/ports';
import type { Alert } from '../../src/core/types';

/** In-memory KeyValueStore. The backing map can be shared to simulate restarts. */
export class FakeStore implements KeyValueStore {
  constructor(public map: Map<string, string> = new Map()) {}
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * Notifier that counts BOTH side channels separately, mirroring the production
 * adapter (one ntfy POST + one local notification per notify call). Lets tests
 * assert "exactly ONE ntfy POST and ONE local notification".
 */
export class CountingNotifier implements Notifier {
  ntfyPosts = 0;
  localNotifications = 0;
  delivered: Alert[] = [];
  async notify(alert: Alert): Promise<void> {
    this.ntfyPosts += 1; // one ntfy.sh POST
    this.localNotifications += 1; // one Capacitor local notification
    this.delivered.push(alert);
  }
}

export class FixedClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}
