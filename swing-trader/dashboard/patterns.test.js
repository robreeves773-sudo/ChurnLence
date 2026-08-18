// Unit tests for patterns.js — each pattern gets a hand-built candle series.
const { detect } = require("./patterns.js");

let pass = 0, fail = 0;
function check(name, hits, wantKey) {
  const found = hits.some(h => h.key === wantKey);
  if (found) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, "-> got:", hits.map(h => h.key + "@" + h.index).join(", ") || "none"); }
}
// build a gentle downtrend/uptrend base of neutral candles
function base(n, start, step) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push({ time: 1000 + i, open: p, high: p + 1.2, low: p - 1.2, close: p + step });
    p += step;
  }
  return out;
}

// 1. Bullish engulfing at the end of a downtrend
{
  const c = base(14, 100, -1);                        // falling
  c.push({ time: 2001, open: 87, high: 87.5, low: 85, close: 85.5 });   // red
  c.push({ time: 2002, open: 85.2, high: 90.5, low: 85, close: 90 });   // big green engulfs
  check("bullish engulfing", detect(c), "engulf_bull");
}
// 2. Bearish engulfing at the end of an uptrend
{
  const c = base(14, 100, +1);
  c.push({ time: 2001, open: 113, high: 115, low: 112.8, close: 114.5 }); // green
  c.push({ time: 2002, open: 114.8, high: 115, low: 109.5, close: 110 }); // big red engulfs
  check("bearish engulfing", detect(c), "engulf_bear");
}
// 3. Morning star
{
  const c = base(14, 100, -1);
  c.push({ time: 2001, open: 87, high: 87.2, low: 82.5, close: 83 });     // long red
  c.push({ time: 2002, open: 82.8, high: 83.4, low: 82.2, close: 82.9 }); // tiny pause
  c.push({ time: 2003, open: 83.2, high: 87.5, low: 83, close: 87 });     // green past midpoint (85)
  check("morning star", detect(c), "morning_star");
}
// 4. Evening star
{
  const c = base(14, 100, +1);
  c.push({ time: 2001, open: 113, high: 117.5, low: 112.8, close: 117 });
  c.push({ time: 2002, open: 117.2, high: 117.8, low: 116.6, close: 117.1 });
  c.push({ time: 2003, open: 116.8, high: 117, low: 112.5, close: 113 }); // red past midpoint (115)
  check("evening star", detect(c), "evening_star");
}
// 5. Three white soldiers
{
  const c = base(14, 100, -0.2);
  let p = 97;
  for (let i = 0; i < 3; i++) {
    c.push({ time: 2001 + i, open: p, high: p + 2.6, low: p - 0.3, close: p + 2.5 });
    p += 2.5;
  }
  check("three white soldiers", detect(c), "soldiers");
}
// 6. Three black crows
{
  const c = base(14, 100, +0.2);
  let p = 103;
  for (let i = 0; i < 3; i++) {
    c.push({ time: 2001 + i, open: p, high: p + 0.3, low: p - 2.6, close: p - 2.5 });
    p -= 2.5;
  }
  check("three black crows", detect(c), "crows");
}
// 7. Hammer in a downtrend
{
  const c = base(14, 100, -1);
  c.push({ time: 2001, open: 86.6, high: 86.9, low: 82.0, close: 86.9 }); // long lower wick
  check("hammer", detect(c), "hammer");
}
// 8. Shooting star in an uptrend
{
  const c = base(14, 100, +1);
  c.push({ time: 2001, open: 113.4, high: 118.5, low: 113.1, close: 113.1 }); // long upper wick
  check("shooting star", detect(c), "shooting_star");
}
// 9. Bullish harami
{
  const c = base(14, 100, -1);
  c.push({ time: 2001, open: 88, high: 88.2, low: 83.5, close: 84 });     // big red
  c.push({ time: 2002, open: 85, high: 86.6, low: 84.8, close: 86.5 });   // small green inside
  check("bullish harami", detect(c), "harami_bull");
}
// 10. Doji
{
  const c = base(14, 100, -0.1);
  c.push({ time: 2001, open: 98.6, high: 100.1, low: 97.1, close: 98.65 });
  check("doji", detect(c), "doji");
}
// 11. No false positives on a flat, boring series (small bodies AND small wicks)
{
  const c = [];
  let p = 100;
  for (let i = 0; i < 30; i++) {
    const step = (i % 2 ? -0.05 : 0.06);
    c.push({ time: 1000 + i, open: p, high: p + 0.12, low: p - 0.12, close: p + step });
    p += step;
  }
  const hits = detect(c);
  if (hits.length === 0) { pass++; console.log("PASS quiet series stays quiet"); }
  else { fail++; console.log("FAIL quiet series -> ", hits.map(h => h.key)); }
}
// 12. enabledKeys filter works
{
  const c = base(14, 100, -1);
  c.push({ time: 2001, open: 86.6, high: 86.9, low: 82.0, close: 86.9 });
  const hits = detect(c, ["doji"]);
  if (!hits.some(h => h.key === "hammer")) { pass++; console.log("PASS filter excludes hammer"); }
  else { fail++; console.log("FAIL filter"); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
