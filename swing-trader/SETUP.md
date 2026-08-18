# Swing Trader — Novice Setup Guide (Windows)

You are setting up a **paper-trading** (fake money) swing bot. Nothing here
touches real funds. It watches LINK, SOL, XRP and ZBCN on Kraken with a
disciplined swing strategy, and you watch IT for 30 days before deciding
anything else.

## What you need
- Windows PC (you have it)
- Python 3.11, 3.12 or 3.13 → https://www.python.org/downloads/
  (During install, TICK "Add python.exe to PATH".)
- This folder placed at: `D:\Projects\swing-trader`

## One-time setup (10 minutes)
Open **Command Prompt** and paste these lines one at a time:

```
cd /d D:\Projects\swing-trader
pip install freqtrade
pip install requests pandas pyarrow
freqtrade install-ui
```

That's it. (Or just tell Claude Code: "Read CLAUDE.md and run Phase 1" and
it will do and verify all of this for you.)

## Daily driving — the 4 buttons
Double-click these in the `scripts` folder:

| Script | What it does |
|---|---|
| `1-check.bat` | Health check — confirms everything is installed right |
| `2-get-data.bat` | Pulls the latest 120 days of Kraken price data |
| `3-backtest.bat` | Tests the strategy against that data, prints a report |
| `4-start-dryrun.bat` | Starts the paper-trading bot (leave the window open) |

While the bot runs, open **http://127.0.0.1:8080** in your browser.
Login: user `rob`, password is in `user_data/config.json` under
`api_server.password`. That's your dashboard: open trades, profit, history.

## The rules that keep you safe
1. **Dry-run stays ON.** `"dry_run": true` in config.json means fake money.
   Don't change it. Claude Code is instructed to refuse to change it.
2. **30-day rule.** Paper trade for at least 30 days before even discussing
   real money. Compare what the bot did vs. what the backtest predicted.
3. **If ever going live (your call, later):** create Kraken API keys with
   **only** "Query" and "Create & modify orders" permissions — NEVER
   withdrawal. Start with money you can lose entirely.
4. **No strategy is proven profitable.** Backtests can mislead (overfitting),
   and automated strategies lose money in bad markets. What IS proven here
   is the process: backtest → paper → small, informed decisions.

## Honest status of the included strategy
On the 119 days of Kraken data available at build time (mostly a falling
market), SwingStrategy made 5 trades for -2.5% — it stayed out of most of
the decline (good) but the sample is far too small to judge. Claude Code's
first real job (CLAUDE.md, Phases 2–3) is downloading 2+ years of data and
tuning/validating properly. Expect iteration, not magic.

## Getting Claude Code to run the show
Open Claude Code in `D:\Projects\swing-trader` and say:

> "Read CLAUDE.md and claude.md. Do Phase 0 research, then verify Phase 1
> setup, and report."

It will research current Freqtrade/Kraken status on the web, verify the
install, run a backtest, and log everything — asking you before changes.
