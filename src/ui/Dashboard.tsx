import { useState } from 'react';
import { formatPrice, formatSignedPct } from '../core/format';
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
    </div>
  );
}

export default function Dashboard({ api }: { api: OverkillApi }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedState = api.states.find((s) => s.coinId === selected);

  return (
    <>
      <RegimeBanner regime={api.regime} />

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
        api.states.map((s) => (
          <CoinRow key={s.coinId} s={s} onClick={() => setSelected(s.coinId)} />
        ))
      )}
    </>
  );
}
