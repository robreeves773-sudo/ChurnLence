// ntfy.sh delivery: a plain outbound HTTP POST. No bot token, no auth, no
// secrets. Works in the app, the runner sandbox, and tests (inject `doFetch`).

import type { AlertEvent } from '../core/types';

const NTFY_BASE = 'https://ntfy.sh';

type FetchFn = typeof fetch;

export async function publishToNtfy(
  topic: string,
  alert: AlertEvent,
  doFetch: FetchFn = fetch,
): Promise<void> {
  const priority = alert.priority === 'high' ? '4' : '3';
  const tags = alert.type === 'FLIP' ? (alert.title.startsWith('BUY') ? 'green_circle' : 'red_circle') : 'warning';
  await doFetch(`${NTFY_BASE}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: alert.title,
      Priority: priority,
      Tags: tags,
    },
    body: alert.body,
  });
}
