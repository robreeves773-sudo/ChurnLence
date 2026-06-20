import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Capacitor LocalNotifications plugin (no native runtime in tests).
const { schedule, requestPermissions, createChannel } = vi.hoisted(() => ({
  schedule: vi.fn().mockResolvedValue(undefined),
  requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
  createChannel: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: { schedule, requestPermissions, createChannel }
}));

import { createCapacitorNotifier } from '../src/platform/capacitor/capacitorNotifier';
import { defaultSettings } from '../src/core/settings';
import type { Alert } from '../src/core/types';

const flip: Alert = {
  type: 'flip',
  coin: 'XRP',
  direction: 'buy',
  date: '2026-06-11',
  title: 'BUY SIGNAL: XRP',
  body: 'Daily close $2.41 crossed ABOVE 200 EMA ($2.36, +2.1%). 2026-06-11.',
  priority: 'high',
  dedupeKey: 'flip:XRP:2026-06-11:buy'
};

describe('createCapacitorNotifier', () => {
  beforeEach(() => {
    schedule.mockClear();
  });

  it('performs exactly one ntfy POST and one local notification per alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = createCapacitorNotifier(() => defaultSettings('overkill-signals-test1234'));
    await notifier.notify(flip);

    expect(fetchMock).toHaveBeenCalledTimes(1); // one ntfy POST
    expect(schedule).toHaveBeenCalledTimes(1); // one local notification

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/overkill-signals-test1234');
    expect(init.method).toBe('POST');
    expect(init.headers.Title).toBe('BUY SIGNAL: XRP');
    expect(init.headers.Priority).toBe('5'); // high
    expect(init.body).toContain('crossed ABOVE 200 EMA');
  });

  it('still delivers the local notification if the ntfy POST fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const notifier = createCapacitorNotifier(() => defaultSettings('overkill-signals-test1234'));
    await notifier.notify(flip);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1); // local notification unaffected
  });
});
