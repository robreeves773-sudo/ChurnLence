import { LocalNotifications } from '@capacitor/local-notifications';
import type { Alert } from '../../core/types';
import type { Notifier } from '../../core/ports';
import type { Settings } from '../../core/settings';

/** Map our priority to an ntfy priority header (5 = high, 3 = default). */
function ntfyPriority(p: Alert['priority']): string {
  return p === 'high' ? '5' : '3';
}

/** A tag/emoji per alert type for the ntfy notification. */
function ntfyTags(alert: Alert): string {
  switch (alert.type) {
    case 'flip':
      return alert.direction === 'buy' ? 'green_circle,chart_with_upwards_trend' : 'red_circle,chart_with_downwards_trend';
    case 'yellow':
      return 'yellow_circle,warning';
    case 'regime':
      return 'satellite';
    case 'stale':
      return 'no_entry,warning';
  }
}

/**
 * Production Notifier. A single `notify()` performs BOTH delivery channels:
 *   1. one plain-HTTP POST to ntfy.sh (no bot token to protect)
 *   2. one Capacitor local notification (works even if ntfy app isn't installed)
 */
export function createCapacitorNotifier(getSettings: () => Settings): Notifier {
  let notifId = Date.now() % 2_000_000_000;

  return {
    async notify(alert: Alert): Promise<void> {
      const settings = getSettings();

      // --- Channel 1: ntfy.sh HTTP POST -----------------------------------
      try {
        await fetch(`${settings.ntfyServer.replace(/\/$/, '')}/${settings.ntfyTopic}`, {
          method: 'POST',
          headers: {
            Title: alert.title,
            Priority: ntfyPriority(alert.priority),
            Tags: ntfyTags(alert)
          },
          body: alert.body
        });
      } catch (err) {
        // Network failure must not block the local notification.
        console.warn('[overkill] ntfy POST failed', err);
      }

      // --- Channel 2: Capacitor local notification ------------------------
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: ++notifId,
              title: alert.title,
              body: alert.body,
              channelId: alert.priority === 'high' ? 'signals-high' : 'signals-default'
            }
          ]
        });
      } catch (err) {
        console.warn('[overkill] local notification failed', err);
      }
    }
  };
}

/** Request notification permission and create the Android channels. */
export async function ensureNotificationSetup(): Promise<void> {
  try {
    await LocalNotifications.requestPermissions();
    await LocalNotifications.createChannel({
      id: 'signals-high',
      name: 'Signal flips',
      description: 'BUY/SELL signal flips and regime changes',
      importance: 5
    });
    await LocalNotifications.createChannel({
      id: 'signals-default',
      name: 'Early warnings',
      description: 'YELLOW-zone entries',
      importance: 3
    });
  } catch (err) {
    console.warn('[overkill] notification setup failed', err);
  }
}
