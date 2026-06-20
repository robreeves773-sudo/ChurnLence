import type { Regime, Side } from './types';

/**
 * Portfolio regime from the share of coins trading above their 200-EMA.
 *  - Constructive: ≥ 60% above
 *  - Defensive:    ≤ 40% above
 *  - Mixed:        in between
 */
export function computeRegime(sides: (Side | null)[]): Regime {
  const known = sides.filter((s): s is Side => s !== null);
  if (known.length === 0) return 'Mixed';
  const above = known.filter((s) => s === 'above').length;
  const ratio = above / known.length;
  if (ratio >= 0.6) return 'Constructive';
  if (ratio <= 0.4) return 'Defensive';
  return 'Mixed';
}
