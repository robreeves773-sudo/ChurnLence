/** UTC date helpers. Signals are defined on UTC daily candles. */

/** Format an epoch (ms) as a UTC YYYY-MM-DD date string. */
export function utcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Local HH:mm given an epoch and an explicit timezone-offset in minutes. */
export function localHourMinute(epochMs: number, tzOffsetMinutes: number): { h: number; m: number } {
  const shifted = new Date(epochMs + tzOffsetMinutes * 60_000);
  return { h: shifted.getUTCHours(), m: shifted.getUTCMinutes() };
}
