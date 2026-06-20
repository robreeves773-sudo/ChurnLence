/**
 * Foreground cadence controller.
 *
 *  - Every 60s while the app is foregrounded → an `intraday` evaluation.
 *  - One guaranteed `close` evaluation at 00:05 UTC (just after the daily
 *    candle close) → the canonical signal-flip check.
 *
 * Background (app not foregrounded) is handled separately by the Capacitor
 * Background Runner (see background/runner.js), capped at 15-min by Android.
 */
export type EvalFn = (mode: 'close' | 'intraday') => Promise<void> | void;

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;

/** ms from `now` until the next 00:05 UTC. */
export function msUntilDailyClose(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 5, 0, 0);
  return next > now ? next - now : next + DAY - now;
}

export interface SchedulerHandle {
  stop(): void;
}

export function startScheduler(run: EvalFn, now: () => number = Date.now): SchedulerHandle {
  const tick = setInterval(() => void run('intraday'), MINUTE);

  let closeTimer: ReturnType<typeof setTimeout>;
  const scheduleClose = () => {
    closeTimer = setTimeout(async () => {
      await run('close');
      scheduleClose(); // re-arm for the next day
    }, msUntilDailyClose(now()));
  };
  scheduleClose();

  // Kick an immediate intraday pass so the UI isn't empty on launch.
  void run('intraday');

  return {
    stop() {
      clearInterval(tick);
      clearTimeout(closeTimer);
    }
  };
}
