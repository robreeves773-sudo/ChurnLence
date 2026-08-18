# claude.md — Project State: swing-trader

## Research Log
- 2026-08-18 (built by Claude chat): Freqtrade 2026.7 confirmed latest-line
  and installed cleanly. Kraken lists all four targets: LINKUSD, SOLUSD,
  XXRPZUSD (XRP/USD), ZBCNUSD (verified via /0/public/AssetPairs, 1431
  pairs). Kraken candle API limited to last 720 candles per timeframe →
  quick_data.py workaround built; deep history requires --dl-trades or
  Kraken CSV archives (Phase 2). Industry research: Freqtrade (52k+ stars)
  chosen as most proven novice-viable engine; TradingView-webhook execution
  deferred to a later phase by design.

## Current State
- Project scaffolded and VALIDATED end-to-end in a Linux sandbox:
  strategy loads, data downloads, backtest completes.
- Mode: DRY-RUN ONLY. dry_run=true. No API keys present.
- Strategy: SwingStrategy (4h; EMA20>EMA50 trend filter; RSI crossed-above
  45 pullback entry; volume>20-bar avg; exits RSI>70 or close<EMA50;
  stoploss -8%; trailing 4% after +8%; ROI table 12/6/3%).
- First backtest (2026-04-30 → 2026-08-18, real Kraken 4h data, bear-heavy
  window): 5 trades, -2.47% total, 20% win rate. Sample too small to judge;
  trend filter correctly kept the bot out of most of the decline.

## Recent Actions
- Built config.json (Kraken, 4 pairs, $1000 paper wallet, max 4 trades,
  FreqUI on 127.0.0.1:8080, random secrets generated).
- Built quick_data.py (120-day Kraken fetch), 4 batch scripts, SETUP.md,
  CLAUDE.md (with mandatory Phase 0 research for Claude Code).
- Tuned RSI entry 35→45 after data analysis showed 35 never triggered
  in 4h uptrends across all four pairs.

## Next Steps
1. Rob: unzip package to D:\Projects\swing-trader, follow SETUP.md.
2. Claude Code: Phase 0 research → Phase 1 verification.
3. Claude Code: Phase 2 deep data download (2+ years, overnight job).
4. Claude Code: Phase 3 hyperopt + walk-forward validation; log to
   logs/experiments.md.
5. Start 30-day dry-run watch; weekly summaries here.

## Open Questions for Rob
- Account size to model for position sizing (config uses $1000 paper)?
- Telegram notifications wanted? (5-min setup, config section exists.)
