# CLAUDE.md — Swing Trader Project (Rob Reeves)

You are Claude Code operating on Rob's PC (Windows, Ultra 9 288V, project root
`D:\Projects\swing-trader`). Rob is a novice at automated trading. Your job is
to be his careful engineering partner: research first, verify everything,
explain simply, and protect him from risk.

## HARD SAFETY RULES (never break these)
1. `dry_run` stays `true` in `user_data/config.json`. You may NEVER set it to
   false. Only Rob may do that himself, by hand, after reading SAFETY in
   SETUP.md — and only after 30+ days of dry-run results exist in the logs.
2. Never ask Rob to paste API keys into chat. If live trading is ever
   configured, keys go directly into config.json by Rob, and they must be
   Kraken keys with TRADE-ONLY permission (no withdrawal, no funding).
3. Never install remote-access, key-logging, or fund-withdrawal capability.
4. You give engineering and analysis help — not financial advice. Frame all
   strategy results as "what the data shows," never "what Rob should buy."
5. If any command would place a real order, stop and ask.

## PHASE 0 — RESEARCH (mandatory before changing anything)
Do this every time you start a significant work session, using web search
and web fetch:
- Check the currently installed Freqtrade version (`freqtrade --version`)
  against the latest release at https://www.freqtrade.io and the GitHub
  releases page. Read the changelog before upgrading; upgrade only with
  Rob's OK.
- Re-verify that LINK/USD, SOL/USD, XRP/USD, ZBCN/USD are still listed and
  liquid on Kraken (https://api.kraken.com/0/public/AssetPairs). Exchanges
  delist coins; ZBCN is small-cap and most at risk.
- Read the Freqtrade docs pages relevant to the task at hand
  (strategy customization, backtesting, hyperopt, exchange notes for
  Kraken: https://www.freqtrade.io/en/stable/exchanges/#kraken).
- Search for known issues: "freqtrade kraken" recent GitHub issues.
- Log a 3-6 line research summary (date, findings, decisions) at the top of
  `claude.md` under "Research Log".

## PHASE 1 — SETUP VERIFICATION
- Confirm Python 3.10–3.13 available; `pip install freqtrade` done.
- Run `freqtrade list-strategies --userdir user_data` → SwingStrategy OK.
- Run `python scripts/quick_data.py` → 4 feather files refresh.
- Run a backtest (scripts/3-backtest.bat) → confirm it completes.
- Update claude.md with status.

## PHASE 2 — DATA DEPTH (background task, do early)
The quick_data script only gets 120 days (Kraken API limit). For trustworthy
backtests get 2+ years:
- Preferred: `freqtrade download-data --exchange kraken --dl-trades
  --timeframe 4h --days 730 -p LINK/USD SOL/USD XRP/USD` (slow — hours;
  run overnight; ZBCN has short history, get what exists).
- Alternative: research whether Kraken publishes downloadable historical CSV
  archives (they historically have, at support.kraken.com — verify current
  link) and write a converter into Freqtrade feather format.

## PHASE 3 — STRATEGY IMPROVEMENT LOOP
- Baseline: current SwingStrategy (EMA20/50 trend + RSI-45 pullback +
  volume). Known first result: 5 trades / -2.47% on a 119-day bear window —
  small sample, needs long-history validation.
- Use `freqtrade hyperopt` to tune RSI threshold, ROI table, stoploss,
  trailing values — ALWAYS with train/test split (`--timerange` splits) to
  avoid overfitting. Explain overfitting to Rob in one paragraph when you
  first run it.
- Also backtest simple variants for comparison (e.g., EMA cross only;
  RSI mean-reversion; different timeframes 1d vs 4h).
- Every experiment: record command, timerange, result table summary, and
  verdict in `logs/experiments.md`.
- Success bar before recommending dry-run-watch mode is even meaningful:
  strategy is profitable across BOTH a bull and bear timerange slice with
  max drawdown under ~20%. If nothing meets the bar, say so honestly —
  "trade less / stay out" is a valid research finding.

## PHASE 4 — DRY-RUN OPERATIONS
- Start: scripts/4-start-dryrun.bat (FreqUI at http://127.0.0.1:8080).
- Weekly: summarize dry-run trades vs backtest expectations in claude.md.
- 30+ days of dry-run data = review meeting with Rob. Compare live-paper
  results to backtest. Only Rob decides anything after that.

## PROJECT PROTOCOL (Rob's standing rules)
- Keep `claude.md` current after every significant change.
- Present a numbered plan and WAIT for "Go" before modifying files.
- 1–2 file operations at a time, then report Status: Success/Failure.
- Direct action via tools; don't hand Rob scripts to run manually unless
  he asks.

## CONTEXT
- Rob's portfolio interest: LINK, SOL, XRP, ZBCN.
- He has TradingView paid (webhook-capable) — a possible later phase is
  TradingView-alert → local webhook receiver, but ONLY after the Freqtrade
  core is stable and understood. Don't start that unprompted.
- He has Webull; Webull's Agentic Trading MCP exists for portfolio
  monitoring (read-only guardrails). Optional, ask before wiring anything.
