/**
 * Capacitor Background Runner entry — best-effort background evaluation.
 *
 * The Background Runner executes in a SANDBOXED JS context (no DOM, no app
 * bundle, only the runner globals: CapacitorKV, CapacitorNotifications, fetch).
 * So this file re-implements a *lightweight* flip check inline rather than
 * importing the app's core modules.
 *
 * Android caps periodic WorkManager tasks at a 15-minute minimum, and on
 * aggressive OEM battery managers (Samsung One UI) the OS may delay or skip
 * runs entirely. This is documented in the README — the canonical, guaranteed
 * signal-flip check is the 00:05 UTC foreground/scheduled evaluation. This
 * background pass is an opportunistic extra, not a guarantee.
 *
 * ALERT-ONLY: reads public candle data and posts notifications. It holds no
 * exchange credentials and reaches no account-scoped or execution endpoints.
 */

const COINS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'PEPE', 'ADA', 'LINK', 'AVAX', 'SUI'];
const EMA_PERIOD = 200;
const KLINES = 'https://api.binance.com/api/v3/klines';

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let prev = sum / period;
  for (let i = period; i < closes.length; i++) prev = closes[i] * k + prev * (1 - k);
  return prev;
}

async function settings() {
  try {
    const raw = CapacitorKV.get('settings:v1').value;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function evaluateCoin(symbol, cfg) {
  const url = `${KLINES}?symbol=${symbol}USDT&interval=1d&limit=${EMA_PERIOD + 60}`;
  const res = await fetch(url);
  if (!res.ok) return;
  const rows = await res.json();
  const closes = rows.map((r) => Number(r[4]));
  const emaVal = ema(closes, EMA_PERIOD);
  if (emaVal == null) return;

  const lastClose = closes[closes.length - 1];
  const openTime = Number(rows[rows.length - 1][0]);
  const date = new Date(openTime).toISOString().slice(0, 10);
  const side = lastClose >= emaVal ? 'above' : 'below';

  const stateKey = `state:${symbol}`;
  let state = {};
  try {
    state = JSON.parse(CapacitorKV.get(stateKey).value || '{}');
  } catch {
    state = {};
  }

  if (state.lastConfirmedSide && side !== state.lastConfirmedSide && date !== state.lastConfirmedDate) {
    const direction = side === 'above' ? 'buy' : 'sell';
    const dedupeKey = `dedupe:flip:${symbol}:${date}:${direction}`;
    if (!CapacitorKV.get(dedupeKey).value) {
      const mode = (cfg && cfg.perCoin && cfg.perCoin[symbol]) || 'yellow';
      if (mode !== 'off') {
        const pct = (((lastClose - emaVal) / emaVal) * 100).toFixed(1);
        const title = `${direction === 'buy' ? 'BUY' : 'SELL'} SIGNAL: ${symbol}`;
        const body = `Daily close crossed ${direction === 'buy' ? 'ABOVE' : 'BELOW'} 200 EMA (${pct}%). ${date}.`;

        if (cfg && cfg.ntfyTopic) {
          try {
            await fetch(`${(cfg.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '')}/${cfg.ntfyTopic}`, {
              method: 'POST',
              headers: { Title: title, Priority: '5' },
              body
            });
          } catch (e) {
            console.warn('ntfy failed', e);
          }
        }
        CapacitorNotifications.schedule([{ id: Date.now() % 2000000000, title, body }]);
        CapacitorKV.set(dedupeKey, '1');
      }
    }
  }
  state.lastConfirmedSide = side;
  state.lastConfirmedDate = date;
  CapacitorKV.set(stateKey, JSON.stringify(state));
}

addEventListener('evaluateSignals', async (resolve, reject) => {
  try {
    const cfg = await settings();
    for (const symbol of COINS) {
      try {
        await evaluateCoin(symbol, cfg);
      } catch (e) {
        console.warn('bg eval failed', symbol, e);
      }
    }
    resolve();
  } catch (e) {
    reject(e);
  }
});
