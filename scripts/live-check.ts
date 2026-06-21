/**
 * Live verification harness — exercises the REAL evaluation core against LIVE
 * CoinGecko data, outside the app and outside Vitest. Unit tests prove the logic
 * with fixtures; this proves the wiring against the real network.
 *
 * It runs the exact production `evaluate()` with the production CoinGecko
 * fetchers, an in-memory KV, and a deliver() that prints each accepted alert.
 * It does NOT trade anything (there is nothing to trade) and by default does NOT
 * push to ntfy — pass `--ntfy <topic>` to also send a real outbound POST.
 *
 * Usage:
 *   npm run verify:live                 # dry run: fetch + evaluate + print
 *   npm run verify:live -- --coins btc,eth,sol
 *   npm run verify:live -- --ntfy my-topic   # also POST accepted alerts to ntfy.sh
 *
 * Note: requires outbound access to api.coingecko.com (and ntfy.sh if --ntfy).
 */

import { evaluate, type EvalDeps } from '../src/core/orchestrator';
import { MemoryKV } from '../src/core/kv';
import { defaultSettings } from '../src/core/settings';
import { fetchDailyCloses, fetchLivePrice } from '../src/data/coingecko';
import { publishToNtfy } from '../src/delivery/ntfy';
import { COINS, COIN_IDS } from '../src/data/coins';
import type { AlertEvent, Coin, Settings } from '../src/core/types';

function parseArgs(argv: string[]): { coins?: string[]; ntfy?: string } {
  const out: { coins?: string[]; ntfy?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--coins') out.coins = argv[++i]?.split(',').map((s) => s.trim().toLowerCase());
    else if (argv[i] === '--ntfy') out.ntfy = argv[++i];
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const coins: Coin[] = args.coins
    ? COINS.filter((c) => args.coins!.includes(c.id))
    : COINS;
  if (coins.length === 0) {
    console.error(`No coins matched. Known ids: ${COIN_IDS.join(', ')}`);
    process.exit(1);
  }

  const decimalsByCoin = new Map(COINS.map((c) => [c.id, c.decimals]));
  const kv = new MemoryKV();
  const settings: Settings = args.ntfy
    ? { ...defaultSettings(COIN_IDS, 'livecheck'), ntfyTopic: args.ntfy }
    : defaultSettings(COIN_IDS, 'livecheck');

  // evaluate() intentionally swallows per-coin fetch errors (it keeps prior
  // state). For a verification tool that hides nothing, surface them here.
  let fetchErrors = 0;
  const deps: EvalDeps = {
    fetchCandles: async (coin) => {
      try {
        return await fetchDailyCloses(coin.coingeckoId);
      } catch (err) {
        fetchErrors++;
        console.error(`  ⚠️  ${coin.symbol}: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
    },
    fetchLivePrice: (coin) => fetchLivePrice(coin.coingeckoId).catch(() => null),
    kv,
    now: () => Date.now(),
    deliver: async (alert: AlertEvent, s: Settings) => {
      console.log(`\n  🔔 DELIVER  [${alert.type}] ${alert.title}`);
      console.log(`     ${alert.body}`);
      console.log(`     priority=${alert.priority} overridesQuiet=${alert.overridesQuietHours} key=${alert.dedupeKey}`);
      if (args.ntfy) {
        await publishToNtfy(s.ntfyTopic, alert);
        console.log(`     ↳ POSTed to ntfy.sh/${s.ntfyTopic}`);
      }
    },
  };

  console.log(`Live check — ${coins.length} coin(s), source=CoinGecko, ntfy=${args.ntfy ?? '(dry run)'}\n`);

  const result = await evaluate(deps, coins, settings, 'foreground');

  if (result.states.length === 0) {
    console.error(
      `\nNo coin states produced${fetchErrors ? ` — ${fetchErrors} fetch error(s) above` : ''}.` +
        `\nThis usually means CoinGecko was unreachable (network egress policy) or` +
        `\nfewer than 200 daily closes were returned. Run from a network that allows` +
        `\napi.coingecko.com.`,
    );
    process.exit(1);
  }

  console.log(
    `${pad('SYM', 6)}${pad('PRICE', 16)}${pad('EMA200', 16)}${pad('DIST', 9)}${pad('ZONE', 8)}${pad('TREND', 10)}${pad('RSI', 6)}PENDING`,
  );
  console.log('-'.repeat(78));
  for (const st of result.states) {
    const dec = decimalsByCoin.get(st.coinId) ?? 2;
    console.log(
      pad(st.symbol, 6) +
        pad('$' + st.price.toFixed(dec), 16) +
        pad('$' + st.ema200.toFixed(dec), 16) +
        pad((st.distancePct >= 0 ? '+' : '') + st.distancePct.toFixed(1) + '%', 9) +
        pad(st.zone, 8) +
        pad(st.trend, 10) +
        pad(String(Math.round(st.rsi)), 6) +
        (st.pendingFlip ? st.pendingFlip.direction : st.stale ? 'STALE' : '-'),
    );
  }

  console.log(`\nRegime: ${result.regime}`);
  console.log(`Alerts fired: ${result.fired.length}${result.fired.length ? '' : ' (no crossovers right now — expected most days)'}`);
}

main().catch((err) => {
  console.error('\nLive check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
