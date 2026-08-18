/* Candlestick pattern detection for Swing Deck.
 *
 * Definitions follow the classic TA-Lib-style rules. The "pct" numbers are
 * reversal success rates measured by Thomas Bulkowski across thousands of
 * stock-market samples (thepatternsite.com) — the most-cited quantitative
 * study of candle patterns. Treat them as CONTEXT, not signals: most candle
 * patterns in isolation are barely better than a coin flip; the strong ones
 * (engulfing, stars, soldiers/crows) earn their keep only alongside the
 * trend and volume — which is exactly what the bot's EMA/RSI filter does.
 */
(function (root) {
  "use strict";

  const body = (c) => Math.abs(c.close - c.open);
  const range = (c) => c.high - c.low;
  const upperWick = (c) => c.high - Math.max(c.open, c.close);
  const lowerWick = (c) => Math.min(c.open, c.close) - c.low;
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;

  // average body of the previous n candles (context for "long"/"small")
  function avgBody(candles, i, n) {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - n); j < i; j++) { s += body(candles[j]); k++; }
    return k ? s / k : 0;
  }
  // simple trend context: close vs the mean close of the prior n candles
  function trend(candles, i, n) {
    if (i < n) return 0;
    let s = 0;
    for (let j = i - n; j < i; j++) s += candles[j].close;
    const m = s / n;
    if (candles[i].close < m * 0.995) return -1;   // downtrend
    if (candles[i].close > m * 1.005) return +1;   // uptrend
    return 0;
  }

  const PATTERNS = [
    {
      key: "engulf_bull", name: "Bullish Engulfing", side: "bull", pct: 63, label: "Eng",
      note: "Big up-candle swallows the prior down-candle after a dip. Bulkowski: acts as a bullish reversal 63% of the time (rank 22 of 103).",
      min: 2,
      test(c, i) {
        const p = c[i - 1], k = c[i];
        return isBear(p) && isBull(k) &&
          k.open <= p.close && k.close >= p.open &&
          body(k) > avgBody(c, i, 14) * 1.2 && trend(c, i - 2, 10) < 0;
      },
    },
    {
      key: "engulf_bear", name: "Bearish Engulfing", side: "bear", pct: 79, label: "Eng",
      note: "Big down-candle swallows the prior up-candle after a rise. One of Bulkowski's strongest: ~79% reversal rate in a bull market.",
      min: 2,
      test(c, i) {
        const p = c[i - 1], k = c[i];
        return isBull(p) && isBear(k) &&
          k.open >= p.close && k.close <= p.open &&
          body(k) > avgBody(c, i, 14) * 1.2 && trend(c, i - 2, 10) > 0;
      },
    },
    {
      key: "morning_star", name: "Morning Star", side: "bull", pct: 78, label: "MS",
      note: "Long red, a small pause candle, then a green close above the red's midpoint. Bulkowski ranks it among the best bullish reversals (~78%).",
      min: 3,
      test(c, i) {
        const a = c[i - 2], b = c[i - 1], k = c[i];
        const ab = avgBody(c, i, 14);
        return isBear(a) && body(a) > ab &&
          body(b) < ab * 0.5 &&
          isBull(k) && k.close > (a.open + a.close) / 2 &&
          trend(c, i - 3, 10) <= 0;
      },
    },
    {
      key: "evening_star", name: "Evening Star", side: "bear", pct: 72, label: "ES",
      note: "Long green, a small pause candle, then a red close below the green's midpoint. Reliable bearish reversal (~72%).",
      min: 3,
      test(c, i) {
        const a = c[i - 2], b = c[i - 1], k = c[i];
        const ab = avgBody(c, i, 14);
        return isBull(a) && body(a) > ab &&
          body(b) < ab * 0.5 &&
          isBear(k) && k.close < (a.open + a.close) / 2 &&
          trend(c, i - 3, 10) >= 0;
      },
    },
    {
      key: "soldiers", name: "Three White Soldiers", side: "bull", pct: 70, label: "3WS",
      note: "Three solid green candles in a row, each closing higher. Strong continuation/reversal signal (~70%), but often late.",
      min: 3,
      test(c, i) {
        for (let j = i - 2; j <= i; j++) {
          const k = c[j];
          if (!isBull(k) || body(k) < avgBody(c, j, 14) * 0.8) return false;
          if (upperWick(k) > body(k) * 0.5) return false;
          if (j > i - 2 && k.close <= c[j - 1].close) return false;
        }
        return true;
      },
    },
    {
      key: "crows", name: "Three Black Crows", side: "bear", pct: 78, label: "3BC",
      note: "Three solid red candles in a row, each closing lower. Strong bearish signal (~78%), but often late.",
      min: 3,
      test(c, i) {
        for (let j = i - 2; j <= i; j++) {
          const k = c[j];
          if (!isBear(k) || body(k) < avgBody(c, j, 14) * 0.8) return false;
          if (lowerWick(k) > body(k) * 0.5) return false;
          if (j > i - 2 && k.close >= c[j - 1].close) return false;
        }
        return true;
      },
    },
    {
      key: "hammer", name: "Hammer", side: "bull", pct: 60, label: "Ham",
      note: "Long lower wick after a dip — sellers pushed, buyers won. ~60% WITH a confirming green candle after it; only ~41% alone.",
      min: 1,
      test(c, i) {
        const k = c[i];
        return lowerWick(k) >= body(k) * 2 &&
          upperWick(k) <= body(k) * 0.5 &&
          range(k) > 0 && body(k) / range(k) < 0.4 &&
          trend(c, i - 1, 10) < 0;
      },
    },
    {
      key: "shooting_star", name: "Shooting Star", side: "bear", pct: 59, label: "SS",
      note: "Long upper wick after a rise — buyers pushed, sellers won. Moderate (~59%); wants a red confirmation candle.",
      min: 1,
      test(c, i) {
        const k = c[i];
        return upperWick(k) >= body(k) * 2 &&
          lowerWick(k) <= body(k) * 0.5 &&
          range(k) > 0 && body(k) / range(k) < 0.4 &&
          trend(c, i - 1, 10) > 0;
      },
    },
    {
      key: "harami_bull", name: "Bullish Harami", side: "bull", pct: 54, label: "Har",
      note: "Small green inside the prior big red — momentum stalling. Weak on its own (~54%); context is everything.",
      min: 2,
      test(c, i) {
        const p = c[i - 1], k = c[i];
        return isBear(p) && body(p) > avgBody(c, i, 14) && isBull(k) &&
          Math.max(k.open, k.close) < p.open && Math.min(k.open, k.close) > p.close &&
          trend(c, i - 2, 10) < 0;
      },
    },
    {
      key: "doji", name: "Doji", side: "neutral", pct: 50, label: "Doji",
      note: "Open ≈ close: indecision. Roughly a coin flip alone — it marks a spot to watch, not a trade.",
      min: 1,
      test(c, i) {
        const k = c[i];
        return range(k) > 0 && body(k) <= range(k) * 0.08 &&
          range(k) > avgBody(c, i, 14) * 0.8 &&
          trend(c, i - 1, 10) !== 0;   // indecision only matters after a move
      },
    },
  ];

  /* Detect all patterns over an array of {time, open, high, low, close}.
   * Returns [{index, time, key, name, side, pct, label, note}], one entry per
   * hit, later patterns win overlaps of the same candle+side (stronger pct
   * first would double-mark; instead we keep the highest-pct per candle+side). */
  function detect(candles, enabledKeys) {
    const out = [];
    const enabled = enabledKeys ? new Set(enabledKeys) : null;
    for (let i = 0; i < candles.length; i++) {
      const perSide = {};
      for (const p of PATTERNS) {
        if (enabled && !enabled.has(p.key)) continue;
        if (i < p.min - 1 || i < 10) continue;   // need trend context
        if (p.test(candles, i)) {
          if (!perSide[p.side] || perSide[p.side].pct < p.pct) {
            perSide[p.side] = { index: i, time: candles[i].time, key: p.key,
              name: p.name, side: p.side, pct: p.pct, label: p.label, note: p.note };
          }
        }
      }
      for (const side in perSide) out.push(perSide[side]);
    }
    return out;
  }

  const api = { PATTERNS, detect };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CandlePatterns = api;
})(typeof self !== "undefined" ? self : this);
