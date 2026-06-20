import type { Alert } from './types';
import type { Notifier } from './ports';
import type { Settings } from './settings';
import { isAllowed } from './settings';
import { DedupeStore } from './dedupe';

/**
 * Gate alerts through settings + dedupe, then deliver the survivors.
 *
 * For each alert that (a) is permitted by per-coin/quiet-hours settings and
 * (b) has not already been delivered, this performs exactly one `notify()` —
 * which is one ntfy POST + one local notification — and marks it deduped.
 *
 * Returns the alerts that were actually delivered.
 */
export async function dispatchAlerts(args: {
  alerts: Alert[];
  settings: Settings;
  dedupe: DedupeStore;
  notifier: Notifier;
  now: number;
}): Promise<Alert[]> {
  const { alerts, settings, dedupe, notifier, now } = args;
  const delivered: Alert[] = [];

  for (const alert of alerts) {
    if (!isAllowed(settings, alert, now)) continue;
    if (await dedupe.seen(alert.dedupeKey)) continue;

    await notifier.notify(alert);
    await dedupe.mark(alert.dedupeKey);
    delivered.push(alert);
  }

  return delivered;
}
