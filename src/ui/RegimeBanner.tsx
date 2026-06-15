import type { RegimeState } from '../core/types';
import { REGIME_COLOR } from '../theme/tokens';

const COPY: Record<RegimeState, string> = {
  Defensive: 'Few coins above their 200 EMA — risk-off.',
  Mixed: 'A split market — selectivity matters.',
  Constructive: 'Most coins above their 200 EMA — risk-on.',
};

export default function RegimeBanner({ regime }: { regime: RegimeState }) {
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
      </div>
      <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>{COPY[regime]}</p>
    </div>
  );
}
