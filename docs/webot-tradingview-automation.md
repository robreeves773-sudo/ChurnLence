# Automating Trading with Webot + TradingView (Research)

**Date:** August 2026
**Goal:** Automate trade execution using a paid TradingView account and Webot
(the US crypto exchange formerly known as Pionex.US).

---

## TL;DR

Yes, this is doable with what you already have — and mostly without writing code.

- **Webot** (formerly Pionex.US) is a US-regulated crypto exchange (NMLS
  #2284360, licensed in 48 states) whose trading bots run **natively on the
  exchange** — no third party holds your API keys.
- Your **paid TradingView plan** is the key unlock: paid tiers (Essential and
  up) allow **webhook URLs on alerts**, which is how TradingView talks to an
  exchange. The free plan cannot do this.
- The cleanest integration is the **Signal Bot**: Webot/Pionex gives you a
  webhook URL + a message template; you paste both into a TradingView alert.
  When your strategy fires, TradingView POSTs the signal and the bot places
  the order. No server, no code.

---

## Option 1 — Built-in bots (zero TradingView needed)

Webot ships ~16 free built-in bots. These don't use TradingView at all — you
configure them in the app and they run 24/7 on the exchange:

| Bot | What it does | Risk notes |
|---|---|---|
| **Grid Bot** | Buys low / sells high inside a price range sliced into grids. Best for sideways, choppy markets. | Underperforms in strong trends; can be left holding through a breakdown. |
| **Martingale / DCA Bot** | Buys more as price drops, sells the whole position when average entry hits the take-profit. | **High risk** — position size grows into a falling market; can deplete capital in a sustained downtrend. |
| **Rebalancing Bot** | Holds a target allocation (e.g. 50/50 BTC/ETH) and auto-buys/sells to maintain it. | Lowest-effort, portfolio-style. |
| **Arbitrage Bot** | Captures spot-futures funding-rate spread. | Returns compress when many users pile in. |

**When to use:** if you just want automation and don't need your own strategy
logic, start here. AI-recommended parameters make setup a few taps.

## Option 2 — Signal Bot + TradingView webhooks (recommended for you)

This is the path that actually uses your paid TradingView account. The Signal
Bot listens for TradingView alerts and executes them on your account.

### How it connects

```
TradingView strategy (Pine Script)
        │  alert fires
        ▼
TradingView webhook (paid-plan feature)
        │  HTTPS POST with JSON message
        ▼
Webot/Pionex Signal Bot endpoint
        │
        ▼
Order placed on your Webot account
```

### Setup steps

1. **On Webot/Pionex** — log in, go to **Bot → Signal Bot → Add Signal**.
   Name the signal. The app shows you two things — copy both:
   - a **Webhook URL**
   - a **Message** template (pre-built JSON with placeholders)
2. **On TradingView** — open your chart/strategy, create an **Alert**:
   - *Condition:* your strategy or indicator signal
   - *Notifications tab:* enable **Webhook URL** and paste the URL from step 1
   - *Message box:* paste the Message template **unchanged** — TradingView
     fills in the placeholders (symbol, side, etc.) when the alert fires.
     Don't hand-edit it unless you know the schema.
3. **Configure the Signal Bot** — investment amount, position sizing
   (single vs. multi position), take-profit/stop-loss if offered.
4. **Test with a tiny amount first.** Fire the alert manually (e.g. a
   condition that triggers immediately) and confirm an order appears on Webot
   before trusting it with real size.

Pionex also publishes an official TradingView strategy —
**"Pionex Signal Bot (Single/Multi Position)" by Jon_Pionex** — that is
pre-wired to emit the right alert payloads. Searching for it in TradingView's
indicator/strategy library is the fastest starting point; you can also clone
it and swap in your own entry/exit logic.

A starter Pine Script strategy template with alert plumbing is in
[`tradingview/signal-strategy-template.pine`](../tradingview/signal-strategy-template.pine).

### Requirements & limits

- TradingView **Essential or higher** (you have this ✅). Alert-with-webhook
  limits by tier: Essential ~20 active alerts, Plus ~100, Premium ~400.
- Webhook alerts fire from TradingView's servers — your computer can be off.
- **Caveat to verify in-app:** the Signal Bot launched on Pionex global under
  Futures. Webot (the US app) is a separate app since the Pionex.US split, and
  US availability of specific bots can differ. Open the Webot app → Bots and
  confirm Signal Bot is listed. If it isn't, use Option 3.

## Option 3 — API fallback (if Signal Bot isn't in the US app)

Webot/Pionex exposes a **RESTful + WebSocket API** (docs at
`pionex.com/docs/api-docs`) with API-key auth and IP whitelisting. Two ways to
use it with TradingView:

1. **Third-party signal relay** — services like 3Commas, WunderTrading,
   Altrady, or GoodCrypto receive your TradingView webhook and place orders on
   the exchange via your API key. Fast to set up, but a third party holds a
   trading-scoped key and most charge ~$20–30/mo.
2. **Self-hosted relay** — a small web service you run (e.g. on a $5 VPS or a
   free-tier cloud function) that receives the TradingView webhook, verifies a
   shared secret, and calls the exchange API. No third party, but you own the
   uptime and security. If you want this, the repo can grow a small Python
   (FastAPI) relay — say the word.

Either way: create the API key with **trade-only permissions (never
withdrawal)** and enable IP whitelisting.

## Recommendation

1. **Start with a Grid or Rebalancing bot** on a small balance to get
   comfortable with the platform — zero code, runs today.
2. **In parallel**, confirm Signal Bot exists in your Webot app, then wire one
   TradingView strategy to it in paper-size amounts. Backtest the strategy in
   TradingView's Strategy Tester first — a strategy that loses in backtest
   will lose faster when automated.
3. Skip Martingale bots until you understand the drawdown behavior — they are
   the #1 way people blow up bot accounts.

## Risk & housekeeping notes

- Automated ≠ profitable. Bots execute your strategy faithfully — including a
  bad one, 24/7, with no hesitation.
- Crypto on Webot is not SIPC/FDIC protected. Only automate money you can
  afford to lose entirely.
- Every filled order is a taxable event in the US; high-frequency grid bots
  can generate thousands of them. Webot fees are ~0.1% maker — factor fees
  into any strategy's expected edge.
- Keep 2FA on, and never share the webhook URL or message template publicly —
  the URL is effectively a limited credential for your signal.

## Sources

- [Webot review — exchange with built-in free AI trading bots (CoinCodeCap)](https://coincodecap.com/webot-review)
- [Webot (formerly Pionex.US) — Google Play listing](https://play.google.com/store/apps/details?id=com.webot&hl=en_US)
- [Pionex.US & Webot are now two separate apps — Pionex US Help Center](https://pionexus.zendesk.com/hc/en-us/articles/53026246448665-Pionex-US-Webot-are-now-Two-Separate-Apps)
- [Signal Bot — Pionex Help Center](https://support.pionex.com/hc/en-us/articles/52606266734105-Signal-Bot)
- [Signal Bot and TradingView tutorial — Pionex blog](https://www.pionex.com/blog/signal-bot-and-tradingview-tutorial/)
- [Pionex Signal Bot — TradingView signal setting tutorial](https://www.pionex.com/blog/signal-tutorial-pionex-new-product/)
- [Pionex Signal Bot (Single/Multi Position) strategy by Jon_Pionex — TradingView](https://www.tradingview.com/script/l83D5Nap-Pionex-Signal-Bot-Single-Multi-Position/)
- [TradingView alerts setup and plan limits](https://www.tv-hub.org/guide/tradingview-alerts-setup)
- [TradingView webhook setup guide — from alert to live broker order (Ontology)](https://blog.ontologytrading.com/tradingview-webhook-setup-guide-from-alert-to-live-broker-order-2026/)
- [Martingale bot guide — Pionex blog](https://www.pionex.com/blog/whats-martingale-bot/)
- [Pionex API docs overview](https://www.pionex.com/docs/api-docs)
