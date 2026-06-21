import type { RegimeState } from '../core/types';
import { REGIME_COLOR } from '../theme/tokens';
import { REGIME_CONSTRUCTIVE_MIN, REGIME_DEFENSIVE_MAX } from '../core/regime';

const COPY: Record<RegimeState, string> = {
  Defensive: 'Few coins above their 200 EMA — risk-off.',
  Mixed: 'A split market — selectivity matters.',
  Constructive: 'Most coins above their 200 EMA — risk-on.',
};

/** Segmented strength meter: one cell per evaluated coin, filled cells = bullish.
 *  Threshold gaps mark the Defensive (≤3) / Constructive (≥7) cutoffs. */
function StrengthMeter({ above, total, color }: { above: number; total: number; color: string }) {
  if (total === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 10 }}>
      {Array.from({ length: total }, (_, i) => {
        const filled = i < above;
        // Visual separators just after the Defensive and just before the Constructive cutoff.
        const gapAfter = i + 1 === REGIME_DEFENSIVE_MAX || i + 1 === REGIME_CONSTRUCTIVE_MIN - 1;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              background: filled ? color : 'var(--ok-border)',
              marginRight: gapAfter ? 6 : 0,
              transition: 'background 0.3s',
            }}
          />
        );
      })}
    </div>
  );
}

export default function RegimeBanner({
  regime,
  aboveCount,
  total,
}: {
  regime: RegimeState;
  aboveCount: number;
  total: number;
}) {
  const color = REGIME_COLOR[regime];
  return (
    <div
      className="ok-card"
      style={{
        padding: '14px 16px',
        marginBottom: 16,
        borderLeft: `4px solid ${color}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="ok-pill" style={{ background: color, color: '#0A0B0D' }}>
          {regime.toUpperCase()}
        </span>
        <span className="ok-muted" style={{ fontSize: '0.85rem' }}>
          Portfolio regime
        </span>
        {total > 0 && (
          <span className="ok-num" style={{ marginLeft: 'auto', fontSize: '0.85rem' }}>
            <span style={{ color, fontWeight: 700 }}>{aboveCount}</span>
            <span className="ok-muted"> / {total} above 200 EMA</span>
          </span>
        )}
      </div>
      <StrengthMeter above={aboveCount} total={total} color={color} />
      <p style={{ margin: '10px 0 0', fontSize: '0.9rem' }}>{COPY[regime]}</p>
    </div>
  );
}
