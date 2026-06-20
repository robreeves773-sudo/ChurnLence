# Overkill Signals — v1.3 Signal Alerts

Daily-close **200-EMA crossover** signal alerts for 10 coins. Capacitor app
(Android + web). **Alert-only**: it notifies a human; the human decides and acts.

> **No trade execution anywhere.** There are no exchange credentials, no
> account-scoped endpoints, and no execution endpoints in this codebase. It only
> ever READS public candle data and sends notifications. This is enforced by
> `npm run verify:no-trade` (CI guard) — the spec's
> *"grep for order/trade/private must return nothing"* acceptance criterion.

---

## What it does

Every evaluation pass reads daily OHLC candles for the 10 tracked coins,
computes the 200-period EMA, and raises four kinds of alert:

| Alert | Trigger | Priority |
| --- | --- | --- |
| **Signal flip** (core) | Daily **close** crosses the 200 EMA (either direction) | high |
| **Yellow entry** | Price enters the ±2% band around the EMA from outside (early warning) | default |
| **Regime change** | Portfolio banner changes (Defensive / Mixed / Constructive) | high |
| **Stale data** | A coin feed is offline > 2h | high |

Each fired alert performs **one ntfy.sh POST + one Capacitor local
notification** (the local one works even if the ntfy app isn't installed).

### Intraday vs close discipline

Intraday crosses are **not** signals. A live price on the wrong side of the EMA
is tracked as a **pending flip** and drawn as a **hollow dot** on the chart. It
is only **confirmed + alerted** on the canonical **00:05 UTC daily-close**
evaluation. This prevents whipsaw spam on volatile days (PEPE can cross the EMA
many times in one session).

Confirmed signals render as **filled dots** (green BUY / red SELL); pending
flips render as **hollow amber rings** — visibly distinct.

### Dedupe

Each alert has a stable key (e.g. `flip:XRP:2026-06-11:buy`). Once fired it is
recorded in Capacitor **Preferences**, so the dedupe **survives app restarts**.
A signal-flip fires at most **once per coin per day per direction**.

---

## Alerts channel — ntfy.sh

Plain HTTP POST, no bot token to protect. On first run the app generates a topic
`overkill-signals-<random8>` and shows it in **Settings**. Subscribe to that
topic in the [ntfy Android app](https://ntfy.sh/) to receive pushes. Settings
has a **Send test alert** button to verify the end-to-end path.

---

## Evaluation cadence

| When | Mode | How |
| --- | --- | --- |
| App foreground | `intraday` | every 60s tick |
| App background | `intraday` | Android **WorkManager** every 15 min (Capacitor Background Runner) |
| **00:05 UTC** | `close` | one guaranteed daily-close check — the canonical signal-flip evaluation |

### ⚠️ Background checks are best-effort (Samsung S24 Ultra)

Android caps periodic background tasks at a **15-minute minimum**, and Samsung
One UI's aggressive battery management will **delay or skip** them. The
guaranteed signal-flip check is the **00:05 UTC** evaluation; background passes
are an opportunistic extra, not a guarantee.

**To make background checks reliable on an S24 Ultra:**
`Settings → Apps → Overkill Signals → Battery → set to **Unrestricted**`.
(Also disable "Put app to sleep" / "Deep sleeping apps" for it.)

---

## Settings

- **Per-coin alert toggles** — `Flip + Yellow` (default) / `Flip only` / `Off`
- **ntfy topic** display + **Send test alert**
- **Quiet hours** — default `23:00–07:00` local. Suppresses everything **except
  signal flips**, which always override.

---

## Project layout

```
src/core/        platform-agnostic, side-effect-free signal engine (unit-tested)
  ema.ts         EMA
  engine.ts      per-coin evaluation (flip/pending/yellow/stale) + intraday-vs-close discipline
  regime.ts      portfolio regime
  messages.ts    ntfy title/body formatting
  settings.ts    per-coin toggles, quiet hours, topic generation
  dedupe.ts      persistent once-per dedupe
  dispatcher.ts  settings + dedupe gate → notifier
  orchestrator.ts full multi-coin pass
  ports/         KeyValueStore / Notifier / Clock seams
src/platform/capacitor/  Preferences, LocalNotifications + ntfy, public market data
src/ui/          chart (filled vs hollow dots), settings screen
src/scheduler/   60s tick + 00:05 UTC daily-close scheduling
background/runner.js  Capacitor Background Runner entry (sandboxed)
test/            vitest suite (acceptance criteria covered)
scripts/check-no-trade.mjs  forbidden-token guard
```

The core never imports Capacitor — platform concerns are injected via the
`ports` interfaces, which is why the engine is fully testable in plain Node.

---

## Scripts

```bash
npm install
npm test               # vitest — 35 tests incl. acceptance criteria
npm run typecheck      # tsc --noEmit
npm run verify:no-trade  # fails if any order/trade/private/auth token appears
npm run build          # tsc + vite build → dist/
npm run dev            # vite dev server
npm run cap:sync       # sync web build into the Android project
```

### Acceptance criteria → tests

| Criterion | Test |
| --- | --- |
| Simulated crossover → exactly ONE ntfy POST and ONE local notification | `test/acceptance.test.ts`, `test/notifier.test.ts` |
| Dedupe survives app restart | `test/acceptance.test.ts` |
| Hollow pending dots distinct from confirmed dots | `test/chart.test.ts` |
| Zero trading/exchange-auth code paths | `npm run verify:no-trade` |
| Intraday crosses don't alert (whipsaw guard) | `test/engine.test.ts` |

---

## Adding the Android platform

```bash
npm run build
npx cap add android
npm run cap:sync
```

Then install the **Background Runner** plugin and copy `background/runner.js`
into the Capacitor runner source path referenced by `capacitor.config.ts`.
Grant the **notifications** permission on first launch.
