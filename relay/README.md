# TradingView → Webot Relay

A tiny web service that turns your TradingView alerts into market orders on
Webot/Pionex — with your **phone as the control panel**.

```
TradingView alert ──HTTPS POST──▶ this relay (cloud) ──API──▶ Webot order
                                        ▲
                              your phone: dashboard,
                              deploy, flip live/dry-run
```

**Why not run it *on* the phone?** TradingView must reach the relay over
public HTTPS every time an alert fires, 24/7. Phones sleep, change networks,
and kill background apps — a missed webhook is a missed trade (TradingView
does not retry). So the relay lives on a free cloud host, and your phone
monitors it. (A Termux-on-Android option is at the bottom if you insist.)

**Safety first:** the relay boots in **DRY-RUN mode** — it logs what it
*would* do and places no orders until you set `LIVE_TRADING=true`. Buys are
hard-capped by `MAX_ORDER_USD`.

---

## Setup — entirely from your phone's browser

### 1. Create a Webot/Pionex API key
In the app/site: profile → **API Management** → create a key with
**trade permission only — never withdrawal**. Save the key and secret
somewhere safe (you'll paste them in step 3).

### 2. Generate a webhook secret
Any long random string. Password-generator output works fine (30+ chars,
letters/numbers only keeps it paste-friendly).

### 3. Deploy to Render (free)
1. Go to [render.com](https://render.com) → sign up (works fine on mobile).
2. **New → Blueprint** → connect GitHub → pick this repo. Render reads
   `render.yaml` from the repo root and configures everything.
3. When prompted for environment variables, paste:
   - `WEBHOOK_SECRET` — from step 2
   - `PIONEX_API_KEY` / `PIONEX_API_SECRET` — from step 1
   - leave `LIVE_TRADING` = `false`
4. Deploy. You get a URL like `https://webot-relay.onrender.com`.
5. **Keep-alive (important):** Render's free tier sleeps after ~15 min idle,
   and a sleeping relay can miss an alert. Fix: free account at
   [cron-job.org](https://cron-job.org) → new job → URL
   `https://YOUR-APP.onrender.com/health` → every 10 minutes.

   (Alternative hosts if you'd rather not do the keep-alive dance: Railway or
   Fly.io ~$5/mo, or any small VPS — run
   `uvicorn main:app --host 0.0.0.0 --port 8000` behind HTTPS.)

### 4. Bookmark your dashboard
Open `https://YOUR-APP.onrender.com/dashboard?key=YOUR_WEBHOOK_SECRET`
on your phone → browser menu → **Add to Home Screen**. That's your live
control panel: every signal, what the relay did, and whether you're in
dry-run or live mode.

### 5. Point TradingView at it
In the TradingView app or site, create an alert on your strategy/indicator:

- **Webhook URL** (Notifications tab): `https://YOUR-APP.onrender.com/webhook`
- **Message** — for a buy alert:

```json
{"secret": "YOUR_WEBHOOK_SECRET", "action": "buy", "symbol": "{{ticker}}", "amount_usd": 25}
```

- Message for a sell alert (sells that % of the coin you hold):

```json
{"secret": "YOUR_WEBHOOK_SECRET", "action": "sell", "symbol": "{{ticker}}", "percent": 100}
```

`{{ticker}}` fills in automatically (e.g. `BTCUSDT` → relay converts to
Pionex's `BTC_USDT`). If you use a strategy (not a simple indicator alert),
`{{strategy.order.action}}` can fill the action field:

```json
{"secret": "YOUR_WEBHOOK_SECRET", "action": "{{strategy.order.action}}", "symbol": "{{ticker}}", "amount_usd": 25}
```

### 6. Test, then go live
1. Fire a test alert (create a throwaway alert with a condition that's
   already true — it triggers immediately).
2. Check the dashboard: you should see the signal with status
   **"dry-run (no order sent)"**. This proves TradingView → relay works.
3. Verify the API keys: on Render → Shell tab (or locally), run
   `python check_setup.py`. It makes one read-only balance call.
4. Only when both pass: set `LIVE_TRADING=true` in Render's Environment tab
   (service restarts automatically). Start with a tiny `amount_usd`.

---

## Alert payload reference

| Field | Required | Meaning |
|---|---|---|
| `secret` | yes | Must equal `WEBHOOK_SECRET` |
| `action` | yes | `buy` or `sell` |
| `symbol` | yes | `BTC_USDT`, `BTCUSDT`, or `{{ticker}}` |
| `amount_usd` | buys | Quote amount to spend (default `DEFAULT_AMOUNT_USD`, capped at `MAX_ORDER_USD`) |
| `percent` | sells | % of held coin to sell (default 100) |

## Endpoints

- `POST /webhook` — TradingView alerts land here
- `GET /dashboard?key=SECRET` — phone dashboard, last 50 signals
- `GET /health` — for uptime pingers

## Important caveats

- **Verify the API base URL for your account.** This client implements the
  public Pionex API (`api.pionex.com`, docs at pionex.com/docs/api-docs).
  Webot split from Pionex.US in 2025/26; if your key was created in the Webot
  app and `check_setup.py` fails, check Webot's own API docs for the correct
  base URL and set `PIONEX_BASE_URL` accordingly. `check_setup.py` passing =
  you're pointed at the right place.
- Market orders only — no limit orders, no leverage, longs only (buy then
  sell what you hold). That's deliberate; it keeps failure modes small.
- The event log lives in SQLite on the host's disk; on free tiers it resets
  on redeploy. Order history on Webot itself is always authoritative.
- Anyone with your webhook secret can make your account trade. Treat the
  dashboard URL like a password; rotate the secret if it leaks.

## Running on Android anyway (not recommended)

Termux can run it: install Termux from F-Droid, `pkg install python`,
`pip install -r requirements.txt`, run uvicorn, then expose it with a
Cloudflare tunnel. It will miss alerts whenever Android sleeps the process
or you lose signal — fine for experimenting, not for real money.

## Disclaimer

Educational tooling, not financial advice. Automated strategies lose money
faithfully and around the clock — test in dry-run, backtest in TradingView,
and only fund what you can afford to lose.
