// App-context delivery: send an accepted alert via BOTH ntfy and a local
// notification. Injected into the orchestrator as `deliver`.

import type { AlertEvent, Settings } from '../core/types';
import { showLocalNotification } from './localNotif';
import { publishToNtfy } from './ntfy';

export async function appDeliver(alert: AlertEvent, settings: Settings): Promise<void> {
  // Both delivery paths fire for one accepted alert. ntfy failures must not
  // block the local notification (and vice-versa).
  await Promise.allSettled([
    publishToNtfy(settings.ntfyTopic, alert),
    showLocalNotification(alert),
  ]);
}
