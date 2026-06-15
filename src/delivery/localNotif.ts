// Capacitor Local Notification delivery (app/foreground context). Fires even
// when the ntfy app isn't installed. The background runner uses the sandbox's
// CapacitorNotifications instead (see overkill.runner.ts).

import { LocalNotifications } from '@capacitor/local-notifications';
import type { AlertEvent } from '../core/types';

let nextId = Date.now() % 1_000_000;

export async function ensureNotificationPermission(): Promise<boolean> {
  const status = await LocalNotifications.checkPermissions();
  if (status.display === 'granted') return true;
  const req = await LocalNotifications.requestPermissions();
  return req.display === 'granted';
}

export async function showLocalNotification(alert: AlertEvent): Promise<void> {
  await LocalNotifications.schedule({
    notifications: [
      {
        id: nextId++,
        title: alert.title,
        body: alert.body,
        schedule: { at: new Date(Date.now() + 100) },
      },
    ],
  });
}
