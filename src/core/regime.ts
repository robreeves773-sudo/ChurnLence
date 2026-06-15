// Portfolio regime banner: derived from how many tracked coins are bullish
// (price >= 200 EMA). Pure.

import type { CoinState, RegimeState } from './types';

// Default thresholds over the count of BULLISH coins (out of however many are
// currently evaluable). Adjustable here in one place.
export const REGIME_DEFENSIVE_MAX = 3; // <= 3 bullish  -> Defensive
export const REGIME_CONSTRUCTIVE_MIN = 7; // >= 7 bullish -> Constructive

export function computeRegime(states: CoinState[]): RegimeState {
  const bullish = states.filter((s) => s.trend === 'BULLISH').length;
  if (bullish <= REGIME_DEFENSIVE_MAX) return 'Defensive';
  if (bullish >= REGIME_CONSTRUCTIVE_MIN) return 'Constructive';
  return 'Mixed';
}
