# Overkill — Signal Alerts (v1.3)

An **alert-only** crypto signal app. It watches 10 coins and notifies you when a
**daily close crosses the 200 EMA** (the core "Overkill" signal), plus early
warnings, regime shifts, and dead-feed alerts. **The app never trades.**

> ### Alert-only by design — no trade execution, ever
> There are **no exchange API keys, no order placement, no trade/account/private
> endpoints** anywhere in this codebase. The app reads **public market data** and
> sends **outbound notifications**. *You* make every trade. This invariant is
> enforced in CI by `tests/no-trade-guard.test.ts`.

## What it does

- **Signal flip (core):** daily close crosses the 200 EMA → `BUY SIGNAL` / `SELL
  SIGNAL`. One alert per coin/day/direction. Sent **high priority** and it
  **overrides quiet hours**.
- **Yellow entry:** price enters the ±2% band around the EMA — an early heads-up
  that a flip may be coming. Per-coin toggle (default on).
- **Regime change:** the portfolio banner flips between **Defensive / Mixed /
  Constructive** (based on how many coins are above their 200 EMA).
- **Stale data:** a coin's feed goes offline > 2h → one alert, because a dead
  feed means missed signals.

### Intraday vs close discipline
Intraday crosses are **not** signals — PEPE can cross the EMA six times in a
volatile session. An intraday cross shows as a **hollow "pending" dot** on the
chart and is only **confirmed + alerted on the daily close** (canonical check at
00:05 UTC). Confirmed crossings render as **filled dots**.

## Delivery: ntfy.sh + local notifications

Every alert is sent two ways at once:
1. **ntfy.sh** — a plain HTTP POST to your topic (no account, no token). Your
   default topic is generated on first run as `overkill-signals-<random8>` and
   shown in **Settings**. Install the **ntfy** Android app and subscribe to that
   topic. Use **Settings → Send test alert** to confirm it works.
2. **Capacitor local notification** — fires on the device even if the ntfy app
   isn't installed.

**Message example**

```
BUY SIGNAL: XRP
Daily close $2.41 crossed ABOVE 200 EMA ($2.36, +2.1%). W:↑ RSI 58. 2026-06-11.
```

## Evaluation cadence

| Context | When | Notes |
| --- | --- | --- |
| Foreground | every 60s | live UI; intraday → pending only |
| Background | every ~15 min | Android WorkManager via `@capacitor/background-runner` (15 min is the OS minimum) |
| Daily close | first wake past 00:05 UTC | canonical signal-flip confirmation |

All three call the **same pure `evaluate()` core** with a shared, persisted
dedupe ledger, so an alert fires **exactly once** regardless of which context
sees the crossover first.

### ⚠️ Background reliability on Samsung (S24 Ultra)
Background checks are **best-effort**. Samsung's aggressive battery management
will throttle or kill the 15-minute task. To make background alerts reliable:

> **Settings → Apps → Overkill → Battery → set to "Unrestricted"**

Also disable "Put app to sleep / Deep sleep" for Overkill. Even then, treat the
foreground app + ntfy as the reliable path; background is a bonus. (The 00:05 UTC
daily-close check is what guarantees the canonical signal once the app next
wakes.)

## Data source

Keyless **CoinGecko** public API. The signal engine uses
`/coins/{id}/market_chart?days=365` for **daily closes** (enough history for a
200-EMA). The chart uses daily closes for the line + a computed EMA(200).

> **Keyless-tier tradeoff:** CoinGecko's free `/ohlc` endpoint only returns
> coarse (≈4-day) candles for long ranges; true daily *candlesticks* need a paid
> key. The strategy keys off the daily *close*, so this doesn't affect signals —
> only the optional candlestick view. Add a key or swap the source in
> `src/data/coingecko.ts` to restore fine candles.

## Project layout

```
src/core/      pure logic: indicators, signal engine, alerts, dedupe, orchestrator (no React/DOM)
src/data/      coins list + CoinGecko client (public market data only)
src/delivery/  ntfy + local-notification delivery
src/runner/    background-runner entry (bundled standalone, no React)
src/ui/        Ionic React screens + ZBCN-inspired dark theme
tests/         Vitest acceptance + unit + no-trade guard
```

## Develop

```bash
npm install
npm run dev        # Ionic React web preview (Preferences/notifications shimmed on web)
npm test           # Vitest — verifies the alert system without a device
npm run build      # type-check + app build + runner bundle
npm run cap:sync   # sync to native (after: npx cap add android)
npm run cap:android
```

### Verifying the alert system
`npm test` is the real proof: a simulated crossover fixture produces **exactly
one ntfy POST and one local notification**, dedupe **survives a simulated
restart**, pending vs confirmed logic holds, quiet hours behave, message strings
match the spec exactly, and the no-trade guard passes. Live HTTP verification
(actual CoinGecko fetch + ntfy push) must run from a device/network that allows
`api.coingecko.com` and `ntfy.sh`.

## Theme
A dark, **ZBCN/Zebec-inspired** palette — near-black background with a neon
lime-green accent. All colors live in `src/theme/tokens.ts` (+ `variables.css`)
for easy re-skinning.
