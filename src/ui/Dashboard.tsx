import { useState } from 'react';
import { formatPrice, formatSignedPct } from '../core/format';
import { YELLOW_BAND_PCT } from '../core/signal';
import type { CoinState } from '../core/types';
import { COINS } from '../data/coins';
import { ZONE_COLOR } from '../theme/tokens';
import CandleChart from './CandleChart';
import RegimeBanner from './RegimeBanner';
import type { OverkillApi } from './useOverkill';

function decimalsFor(coinId: string): number {
  return COINS.find((c) => c.id === coinId)?.decimals ?? 2;
}
function coingeckoIdFor(coinId: string): string {
  return COINS.find((c) => c.id === coinId)?.coingeckoId ?? coinId;
}

// Half-range (in %) the distance meter spans on each side of the EMA before the
// marker pins to an edge. Wide enough to keep the ±2% band visually meaningful.
const METER_RANGE = 8;

/** Glanceable position of price relative to the 200 EMA, with the ±2% yellow
 *  band marked and the EMA at center. Turns "+2.1%" into something scannable. */
function DistanceMeter({ distancePct, zone }: { distancePct: number; zone: CoinState['zone'] }) {
  const toPct = (v: number) => ((Math.max(-METER_RANGE, Math.min(METER_RANGE, v)) + METER_RANGE) / (2 * METER_RANGE)) * 100;
  const markerLeft = toPct(distancePct);
  const bandLeft = toPct(-YELLOW_BAND_PCT);
  const bandRight = toPct(YELLOW_BAND_PCT);
  return (
    <div
      style={{ position: 'relative', height: 8, marginTop: 10, borderRadius: 4, background: 'var(--ok-border)' }}
      aria-hidden
    >
      {/* ±band */}
      <div
        style={{
          position: 'absolute',
          left: `${bandLeft}%`,
          width: `${bandRight - bandLeft}%`,
          top: 0,
          bottom: 0,
          background: 'rgba(245, 166, 35, 0.22)',
          borderRadius: 4,
        }}
      />
      {/* EMA center line */}
      <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--ok-muted)' }} />
      {/* price marker */}
      <div
        style={{
          position: 'absolute',
          left: `${markerLeft}%`,
          top: '50%',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: ZONE_COLOR[zone],
          transform: 'translate(-50%, -50%)',
          boxShadow: '0 0 0 2px var(--ok-surface)',
          transition: 'left 0.4s ease',
        }}
      />
    </div>
  );
}

function CoinRow({ s, onClick }: { s: CoinState; onClick: () => void }) {
  const d = decimalsFor(s.coinId);
  return (
    <div
      className="ok-card"
      onClick={onClick}
      style={{ padding: '12px 14px', marginBottom: 10, cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{s.symbol}</strong>
          <span
            className="ok-pill"
            style={{ background: ZONE_COLOR[s.zone], color: '#0A0B0D' }}
          >
            {s.zone}
          </span>
          {s.pendingFlip && (
            <span
              className="ok-pill"
              style={{ border: `1px solid ${ZONE_COLOR.YELLOW}`, color: ZONE_COLOR.YELLOW }}
              title="Intraday cross — pending daily close"
            >
              ◌ PENDING {s.pendingFlip.direction}
            </span>
          )}
          {s.stale && (
            <span className="ok-pill" style={{ border: '1px solid #8A93A3', color: '#8A93A3' }}>
              OFFLINE
            </span>
          )}
        </div>
        <span className="ok-num">{formatPrice(s.price, d)}</span>
      </div>
      <div
        className="ok-num ok-muted"
        style={{ marginTop: 6, fontSize: '0.8rem', display: 'flex', gap: 14 }}
      >
        <span>
          EMA200 {formatPrice(s.ema200, d)}
        </span>
        <span className={s.distancePct >= 0 ? 'ok-bullish' : 'ok-bearish'}>
          {formatSignedPct(s.distancePct)}
        </span>
        <span>RSI {Math.round(s.rsi)}</span>
        <span className={s.trend === 'BULLISH' ? 'ok-bullish' : 'ok-bearish'}>{s.trend}</span>
      </div>
      <DistanceMeter distancePct={s.distancePct} zone={s.zone} />
    </div>
  );
}

/** Most actionable first: pending intraday crosses pinned on top, then ordered
 *  by proximity to the EMA (closest = most likely to flip next). */
function byActionability(a: CoinState, b: CoinState): number {
  const ap = a.pendingFlip ? 0 : 1;
  const bp = b.pendingFlip ? 0 : 1;
  if (ap !== bp) return ap - bp;
  return Math.abs(a.distancePct) - Math.abs(b.distancePct);
}

export default function Dashboard({ api }: { api: OverkillApi }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedState = api.states.find((s) => s.coinId === selected);
  const aboveCount = api.states.filter((s) => s.trend === 'BULLISH').length;
  const sorted = [...api.states].sort(byActionability);

  return (
    <>
      <RegimeBanner regime={api.regime} aboveCount={aboveCount} total={api.states.length} />

      {selectedState && (
        <div className="ok-card" style={{ padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>{selectedState.symbol} — daily</strong>
            <span className="ok-muted" onClick={() => setSelected(null)} style={{ cursor: 'pointer' }}>
              ✕ close
            </span>
          </div>
          <CandleChart
            coingeckoId={coingeckoIdFor(selectedState.coinId)}
            ema200={selectedState.ema200}
            pending={selectedState.pendingFlip}
          />
        </div>
      )}

      {api.states.length === 0 ? (
        <p className="ok-muted">No data yet — coins need ≥200 daily closes to compute the EMA.</p>
      ) : (
        <>
          <div className="ok-muted" style={{ fontSize: '0.72rem', margin: '0 2px 10px', letterSpacing: '0.02em' }}>
            Sorted by proximity to a flip · ◌ pending crosses on top
          </div>
          {sorted.map((s) => (
            <CoinRow key={s.coinId} s={s} onClick={() => setSelected(s.coinId)} />
          ))}
        </>
      )}
    </>
  );
}
