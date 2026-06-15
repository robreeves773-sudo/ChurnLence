// Daily-close chart: close line + computed EMA(200) line. Confirmed crossings
// render as FILLED markers; the current intraday pending flip renders as a
// distinct HOLLOW dot via an SVG overlay (lightweight-charts markers cannot be
// hollow). Uses daily closes (consistent with the signal engine) rather than
// the keyless coarse OHLC feed.

import { useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { ema } from '../core/indicators';
import { EMA_PERIOD } from '../core/signal';
import type { Candle, PendingFlip } from '../core/types';
import { fetchDailyCloses } from '../data/coingecko';
import { COLORS } from '../theme/tokens';

export default function CandleChart({
  coingeckoId,
  ema200,
  pending,
}: {
  coingeckoId: string;
  ema200: number;
  pending: PendingFlip | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let chart: IChartApi | undefined;
    let closeSeries: ISeriesApi<'Line'> | undefined;
    let disposed = false;

    chart = createChart(host, {
      height: 240,
      layout: {
        background: { color: COLORS.surface },
        textColor: COLORS.muted,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: COLORS.border },
        horzLines: { color: COLORS.border },
      },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border },
    });

    closeSeries = chart.addSeries(LineSeries, { color: COLORS.secondary, lineWidth: 2 });
    const emaSeries = chart.addSeries(LineSeries, { color: COLORS.primary, lineWidth: 2 });

    (async () => {
      let candles: Candle[];
      try {
        candles = await fetchDailyCloses(coingeckoId);
      } catch {
        return;
      }
      if (disposed || !closeSeries) return;

      const closes = candles.map((c) => c.close);
      const emaVals = ema(closes, EMA_PERIOD);

      closeSeries.setData(candles.map((c) => ({ time: c.date as Time, value: c.close })));
      emaSeries.setData(
        candles
          .map((c, i) => ({ time: c.date as Time, value: emaVals[i] }))
          .filter((p) => p.value != null) as { time: Time; value: number }[],
      );

      // Confirmed crossings -> filled markers.
      const markers: SeriesMarker<Time>[] = [];
      for (let i = 1; i < closes.length; i++) {
        const a = emaVals[i - 1];
        const b = emaVals[i];
        if (a == null || b == null) continue;
        const wasAbove = closes[i - 1] >= a;
        const isAbove = closes[i] >= b;
        if (wasAbove !== isAbove) {
          markers.push({
            time: candles[i].date as Time,
            position: isAbove ? 'belowBar' : 'aboveBar',
            color: isAbove ? COLORS.bullish : COLORS.bearish,
            shape: 'circle',
            text: isAbove ? 'BUY' : 'SELL',
          });
        }
      }
      createSeriesMarkers(closeSeries, markers);
      chart!.timeScale().fitContent();

      // Hollow pending dot at the latest point, repositioned on range/resize.
      const lastDate = candles[candles.length - 1]?.date as Time | undefined;
      const lastClose = closes[closes.length - 1];
      const drawPending = () => {
        const svg = overlayRef.current;
        if (!svg || !chart || !closeSeries) return;
        svg.innerHTML = '';
        if (!pending || lastDate === undefined) return;
        const x = chart.timeScale().timeToCoordinate(lastDate);
        const y = closeSeries.priceToCoordinate(lastClose);
        if (x == null || y == null) return;
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', String(x));
        c.setAttribute('cy', String(y));
        c.setAttribute('r', '6');
        c.setAttribute('fill', 'none');
        c.setAttribute('stroke', COLORS.yellow);
        c.setAttribute('stroke-width', '2');
        svg.appendChild(c);
      };
      drawPending();
      chart!.timeScale().subscribeVisibleLogicalRangeChange(drawPending);
    })();

    const ro = new ResizeObserver(() => {
      if (chart && host) chart.applyOptions({ width: host.clientWidth });
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      chart?.remove();
    };
  }, [coingeckoId, ema200, pending]);

  return (
    <div style={{ position: 'relative' }}>
      <div ref={hostRef} />
      <svg
        ref={overlayRef}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}
      />
    </div>
  );
}
