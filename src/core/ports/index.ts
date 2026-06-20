import type { Alert } from '../types';

/**
 * Ports = the seams between the pure core and the outside world. Production
 * wires Capacitor adapters into these; tests wire in-memory fakes.
 */

/** A persisted key/value store (Capacitor Preferences in production). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Delivers an alert to the user. A single call performs BOTH side channels:
 * one ntfy.sh HTTP POST and one Capacitor local notification. The acceptance
 * criteria count "one ntfy POST and one local notification" per fired alert.
 */
export interface Notifier {
  notify(alert: Alert): Promise<void>;
}

/** Injectable clock so evaluation is deterministic under test. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
