"""ChurnLence portfolio tracker with live market data and Overkill-style indicators."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import random
import smtplib
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Iterable

import yfinance as yf
from flask import Flask, Response, g, jsonify, render_template, request

# When packaged with PyInstaller, source files live in a temp extraction dir
# pointed to by sys._MEIPASS; outside the bundle, use the script's folder.
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    HERE = sys._MEIPASS  # type: ignore[attr-defined]
else:
    HERE = os.path.dirname(os.path.abspath(__file__))

# Tell Flask explicitly where templates / static live so the packaged exe
# resolves them inside _MEIPASS instead of the (read-only) install dir.
app = Flask(
    __name__,
    template_folder=os.path.join(HERE, "templates"),
    static_folder=os.path.join(HERE, "static"),
)


def _default_db_path() -> str:
    """User-writable location for the SQLite DB.

    - $CHURNLENCE_DB wins if set (used by the Docker images).
    - Windows: %LOCALAPPDATA%\\ChurnLence\\portfolio.db so the packaged .exe
      survives reinstalls and never tries to write inside Program Files.
    - macOS / Linux: ~/.churnlence/portfolio.db.
    - Falls back to alongside the script in dev.
    """
    env = os.environ.get("CHURNLENCE_DB")
    if env:
        return env
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        target_dir = os.path.join(base, "ChurnLence")
    elif sys.platform == "darwin" or sys.platform.startswith("linux"):
        target_dir = os.path.join(os.path.expanduser("~"), ".churnlence")
    else:
        target_dir = HERE
    try:
        os.makedirs(target_dir, exist_ok=True)
        return os.path.join(target_dir, "portfolio.db")
    except OSError:
        return os.path.join(HERE, "portfolio.db")


DB_PATH = _default_db_path()
DEMO_MODE = os.environ.get("CHURNLENCE_DEMO", "").lower() in ("1", "true", "yes")
QUOTE_TTL = 2 if DEMO_MODE else 15  # seconds — shorter in demo so prices tick visibly
STREAM_INTERVAL = 5  # seconds between SSE pushes
ALERT_INTERVAL = 300  # seconds between signal-transition checks for email alerts

# SMTP config for signal-transition email alerts. All must be set to enable emails.
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER)

# Optional: WhaleAlert API key for big on-chain transfer alerts.
# Free tier exists at https://whale-alert.io/  — sign up, paste the key into
# the env var, and the /api/whales endpoint starts returning real data.
WHALEALERT_KEY = os.environ.get("WHALEALERT_API_KEY", "")

# Curated symbol universe for autocomplete. Covers the usual asks from an
# individual retail tracker: mega-caps, popular ETFs, and top crypto.
SYMBOL_UNIVERSE: list[dict] = [
    # Major caps
    {"symbol": "BTC-USD", "name": "Bitcoin",   "kind": "crypto"},
    {"symbol": "ETH-USD", "name": "Ethereum",  "kind": "crypto"},
    {"symbol": "SOL-USD", "name": "Solana",    "kind": "crypto"},
    {"symbol": "XRP-USD", "name": "XRP",       "kind": "crypto"},
    {"symbol": "ADA-USD", "name": "Cardano",   "kind": "crypto"},
    {"symbol": "DOGE-USD","name": "Dogecoin",  "kind": "crypto"},
    {"symbol": "LINK-USD","name": "Chainlink", "kind": "crypto"},
    {"symbol": "AVAX-USD","name": "Avalanche", "kind": "crypto"},
    {"symbol": "DOT-USD", "name": "Polkadot",  "kind": "crypto"},

    # User's holdings (verified Yahoo coverage where possible)
    {"symbol": "VET-USD", "name": "VeChain",         "kind": "crypto"},
    {"symbol": "ALGO-USD","name": "Algorand",        "kind": "crypto"},
    {"symbol": "XLM-USD", "name": "Stellar",         "kind": "crypto"},
    {"symbol": "HBAR-USD","name": "Hedera",          "kind": "crypto"},
    {"symbol": "SHIB-USD","name": "Shiba Inu",       "kind": "crypto"},
    {"symbol": "CRO-USD", "name": "Cronos",          "kind": "crypto"},
    {"symbol": "FLR-USD", "name": "Flare",           "kind": "crypto"},

    # Memecoins / Solana ecosystem (CoinGecko fallback)
    {"symbol": "BONK-USD","name": "Bonk",            "kind": "crypto"},
    {"symbol": "PEPE-USD","name": "Pepe",            "kind": "crypto"},
    {"symbol": "FLOKI-USD","name": "Floki",          "kind": "crypto"},
    {"symbol": "WIF-USD", "name": "dogwifhat",       "kind": "crypto"},
    {"symbol": "PENGU-USD","name": "Pudgy Penguins", "kind": "crypto"},
    {"symbol": "ZBCN-USD","name": "Zebec Network",   "kind": "crypto"},

    # Newer launches (likely CoinGecko-only)
    {"symbol": "ZORA-USD","name": "Zora",                       "kind": "crypto"},
    {"symbol": "SXT-USD", "name": "Space and Time",             "kind": "crypto"},
    {"symbol": "WLFI-USD","name": "World Liberty Financial",    "kind": "crypto"},

    # Solana ecosystem (kept in autocomplete for memecoin scanner adds)
    {"symbol": "JUP-USD", "name": "Jupiter",   "kind": "crypto"},
    {"symbol": "PYTH-USD","name": "Pyth",      "kind": "crypto"},
    {"symbol": "JTO-USD", "name": "Jito",      "kind": "crypto"},

    # AI / DePIN / L2s — popular discovery picks
    {"symbol": "RNDR-USD","name": "Render",    "kind": "crypto"},
    {"symbol": "TAO-USD", "name": "Bittensor", "kind": "crypto"},
    {"symbol": "FET-USD", "name": "Fetch.ai",  "kind": "crypto"},
    {"symbol": "TIA-USD", "name": "Celestia",  "kind": "crypto"},
    {"symbol": "SUI-USD", "name": "Sui",       "kind": "crypto"},
    {"symbol": "SEI-USD", "name": "Sei",       "kind": "crypto"},
    {"symbol": "INJ-USD", "name": "Injective", "kind": "crypto"},
    {"symbol": "ARB-USD", "name": "Arbitrum",  "kind": "crypto"},
    {"symbol": "OP-USD",  "name": "Optimism",  "kind": "crypto"},
    {"symbol": "APT-USD", "name": "Aptos",     "kind": "crypto"},
    {"symbol": "NEAR-USD","name": "NEAR",      "kind": "crypto"},
    {"symbol": "LDO-USD", "name": "Lido DAO",  "kind": "crypto"},
    {"symbol": "AAVE-USD","name": "Aave",      "kind": "crypto"},
]


# Map ChurnLence symbols → CoinGecko coin IDs. Used when yfinance has no data
# (most small alts and brand-new listings).  yfinance is preferred when it
# works — better OHLC + same currency.  SXT/WLFI/ZORA/PENGU may need
# correction once we see live data; the symbol-resolve flow handles that.
COINGECKO_MAP: dict[str, str] = {
    "BTC-USD":  "bitcoin",
    "ETH-USD":  "ethereum",
    "SOL-USD":  "solana",
    "XRP-USD":  "ripple",
    "ADA-USD":  "cardano",
    "DOGE-USD": "dogecoin",
    "LINK-USD": "chainlink",
    "AVAX-USD": "avalanche-2",
    "DOT-USD":  "polkadot",
    "VET-USD":  "vechain",
    "ALGO-USD": "algorand",
    "XLM-USD":  "stellar",
    "HBAR-USD": "hedera-hashgraph",
    "SHIB-USD": "shiba-inu",
    "CRO-USD":  "crypto-com-chain",
    "FLR-USD":  "flare-networks",
    "BONK-USD": "bonk",
    "PEPE-USD": "pepe",
    "FLOKI-USD":"floki",
    "WIF-USD":  "dogwifcoin",
    "PENGU-USD":"pudgy-penguins",
    "ZBCN-USD": "zebec-network",
    "ZBC-USD":  "zebec-protocol",
    "ZORA-USD": "zora",
    "SXT-USD":  "space-and-time",
    "WLFI-USD": "world-liberty-financial-wlfi",
    "JUP-USD":  "jupiter-exchange-solana",
    "PYTH-USD": "pyth-network",
    "JTO-USD":  "jito-governance-token",
    "RNDR-USD": "render-token",
    "TAO-USD":  "bittensor",
    "FET-USD":  "fetch-ai",
    "TIA-USD":  "celestia",
    "SUI-USD":  "sui",
    "SEI-USD":  "sei-network",
    "INJ-USD":  "injective-protocol",
    "ARB-USD":  "arbitrum",
    "OP-USD":   "optimism",
    "APT-USD":  "aptos",
    "NEAR-USD": "near",
    "LDO-USD":  "lido-dao",
    "AAVE-USD": "aave",
}

# Preset baskets — one-click add. Crypto-only after the refocus.
PRESET_BASKETS: dict[str, dict] = {
    "majors": {
        "name": "Top 6 majors",
        "description": "BTC, ETH, SOL, XRP, ADA, DOGE",
        "symbols": ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD"],
    },
    "memecoins": {
        "name": "Memecoins",
        "description": "DOGE, SHIB, PEPE, BONK, FLOKI, WIF, PENGU",
        "symbols": ["DOGE-USD", "SHIB-USD", "PEPE-USD", "BONK-USD", "FLOKI-USD", "WIF-USD", "PENGU-USD"],
    },
    "solana": {
        "name": "Solana ecosystem",
        "description": "SOL, JUP, PYTH, JTO, BONK, WIF, ZBCN",
        "symbols": ["SOL-USD", "JUP-USD", "PYTH-USD", "JTO-USD", "BONK-USD", "WIF-USD", "ZBCN-USD"],
    },
    "ai": {
        "name": "AI / DePIN",
        "description": "TAO, RNDR, FET, NEAR",
        "symbols": ["TAO-USD", "RNDR-USD", "FET-USD", "NEAR-USD"],
    },
}

_quote_cache: dict[str, tuple[float, dict]] = {}
_quote_lock = threading.Lock()
TICKER_INDEX: dict[str, dict] = {t["symbol"]: t for t in SYMBOL_UNIVERSE}


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    shares REAL NOT NULL,
    cost_basis REAL NOT NULL,
    note TEXT,
    acquired_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id);

-- Realized sell transactions for tax-lot tracking.
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    shares REAL NOT NULL,                -- shares sold (positive)
    sell_price REAL NOT NULL,            -- price per share on sale
    cost_basis REAL NOT NULL,            -- cost per share of the lot(s) sold (weighted)
    proceeds REAL NOT NULL,              -- shares * sell_price
    realized_pl REAL NOT NULL,           -- proceeds - shares * cost_basis
    method TEXT NOT NULL DEFAULT 'FIFO', -- FIFO | LIFO
    lot_ids TEXT,                        -- JSON array of lot IDs drawn down
    sold_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id);

-- Signal-transition history (for email alerts + signal feed).
CREATE TABLE IF NOT EXISTS signal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    from_signal TEXT,
    to_signal TEXT NOT NULL,
    price REAL NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signal_events_portfolio ON signal_events(portfolio_id, created_at);

-- Per-portfolio alert preferences (email + opt-in flags + daily digest).
CREATE TABLE IF NOT EXISTS alert_prefs (
    portfolio_id INTEGER PRIMARY KEY REFERENCES portfolios(id) ON DELETE CASCADE,
    email TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,           -- per-transition emails
    daily_digest INTEGER NOT NULL DEFAULT 0,      -- one summary per day
    digest_hour_utc INTEGER NOT NULL DEFAULT 13,  -- 13:00 UTC = ~9am ET
    last_digest_date TEXT,                        -- YYYY-MM-DD; throttle to once per day
    discord_webhook TEXT,                         -- POST signal flips here
    discord_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-coin custom thesis: user-defined BUY/SELL rules layered on top of the
-- default Overkill signal.  Rules are a tiny whitelisted DSL — see
-- _evaluate_rule() in app.py.
CREATE TABLE IF NOT EXISTS coin_theses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    buy_rules  TEXT NOT NULL DEFAULT '[]',  -- JSON: [{logic, conds:[{indicator,op,value}]}]
    sell_rules TEXT NOT NULL DEFAULT '[]',
    notes TEXT DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_signal TEXT,
    last_fired_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_theses_pid_sym ON coin_theses(portfolio_id, symbol);

-- Server-side watchlist (canonical).  Used by the signal-watcher loop so
-- alerts fire even for coins the user doesn't own.  Frontend keeps a
-- localStorage mirror for offline fallback.
CREATE TABLE IF NOT EXISTS watchlist (
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (portfolio_id, symbol)
);

-- Symbol alert rules: price threshold, % move, volume spike, signal flip.
-- Evaluated each tick of _signal_watcher_loop; debounced by last_fired_at.
CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,        -- price_above|price_below|pct_move_24h|volume_spike|signal_flip
    params TEXT NOT NULL,      -- JSON: {"value":150} or {"pct":-15} or {"threshold":3.0}
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_pid_sym ON alert_rules(portfolio_id, symbol);

-- Jarvis memory: preferences, facts and conversation summaries injected into
-- the system prompt so the agent remembers the user across sessions.
CREATE TABLE IF NOT EXISTS jarvis_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,        -- preference|fact|summary
    key TEXT,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_jarvis_mem_pid_kind ON jarvis_memory(portfolio_id, kind);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive migrations for DBs created by older versions."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(holdings)").fetchall()}
    if "acquired_at" not in cols:
        conn.execute("ALTER TABLE holdings ADD COLUMN acquired_at TEXT")
    ap_cols = {row[1] for row in conn.execute("PRAGMA table_info(alert_prefs)").fetchall()}
    if ap_cols:  # table exists from prior version — add new columns
        for col, ddl in [
            ("daily_digest",     "INTEGER NOT NULL DEFAULT 0"),
            ("digest_hour_utc",  "INTEGER NOT NULL DEFAULT 13"),
            ("last_digest_date", "TEXT"),
            ("discord_webhook",  "TEXT"),
            ("discord_enabled",  "INTEGER NOT NULL DEFAULT 0"),
        ]:
            if col not in ap_cols:
                conn.execute(f"ALTER TABLE alert_prefs ADD COLUMN {col} {ddl}")


def get_db() -> sqlite3.Connection:
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON;")
    return db


@app.teardown_appcontext
def _close_db(_exc):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
        row = conn.execute("SELECT COUNT(*) FROM portfolios").fetchone()
        if row[0] == 0:
            conn.execute("INSERT INTO portfolios(name) VALUES (?)", ("Main",))
        conn.commit()
    finally:
        conn.close()


@contextmanager
def direct_db():
    """Database handle for background threads where Flask's `g` isn't available."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Market data + Overkill indicators
# ---------------------------------------------------------------------------

@dataclass
class Quote:
    symbol: str
    price: float
    change: float
    change_pct: float
    currency: str
    name: str
    ema9: float | None
    ema21: float | None
    ema50: float | None
    ema200: float | None
    atr: float | None             # 14-period Average True Range
    atr_pct: float | None         # ATR as % of price (volatility gauge)
    rsi: float | None             # 14-period RSI (>70 overbought, <30 oversold)
    rsi_label: str                # "overbought" | "oversold" | "neutral"
    macd: float | None            # MACD line value (latest)
    macd_signal: float | None     # MACD signal line value (latest)
    macd_hist: float | None       # histogram (line - signal)
    bb_upper: float | None        # Bollinger upper band (latest)
    bb_mid: float | None          # Bollinger middle (SMA20)
    bb_lower: float | None        # Bollinger lower band
    bb_pct: float | None          # %B: position within bands 0..1
    bb_width: float | None        # band width / mid (volatility gauge; squeezes near 0)
    volume_24h: float | None      # last bar's volume (USD for crypto)
    rvol: float | None            # relative volume vs 20-bar avg; >1.5 = above avg, >3 = unusual
    rvol_label: str               # "low" | "normal" | "high" | "unusual"
    stop_loss: float | None       # Overkill MA-style: ~3% below EMA21
    stop_atr: float | None        # Volatility-aware: price - 2×ATR
    signal: str                   # BUY / SELL / HOLD
    signal_reason: str
    history: list[dict]
    fetched_at: str

    def as_dict(self) -> dict:
        return self.__dict__


def _ema(values: list[float], period: int) -> list[float]:
    if not values or period <= 0:
        return []
    k = 2 / (period + 1)
    out: list[float] = []
    ema = values[0]
    for v in values:
        ema = v * k + ema * (1 - k)
        out.append(ema)
    return out


def _atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> list[float]:
    """Wilder's Average True Range."""
    n = len(closes)
    if n == 0 or len(highs) != n or len(lows) != n:
        return []
    trs: list[float] = [highs[0] - lows[0]]
    for i in range(1, n):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        trs.append(tr)
    out: list[float] = []
    if n < period:
        # fall back to running mean
        running = 0.0
        for i, tr in enumerate(trs):
            running += tr
            out.append(running / (i + 1))
        return out
    seed = sum(trs[:period]) / period
    out.extend([seed] * period)  # pad so indexes align with closes
    out[period - 1] = seed
    atr = seed
    for i in range(period, n):
        atr = (atr * (period - 1) + trs[i]) / period
        out.append(atr)
    return out[:n]


def _rsi(closes: list[float], period: int = 14) -> list[float]:
    """Wilder's RSI (Relative Strength Index).

    >70 = overbought (often fades), <30 = oversold (often bounces).  We use
    50 as a trend-bias filter: above 50 = bullish bias, below 50 = bearish.
    The padding strategy mirrors _atr — we pad the first `period` indices with
    the seed value so output length matches `closes`.
    """
    n = len(closes)
    if n < period + 1:
        return [50.0] * n  # not enough data — neutral
    gains = [0.0]
    losses = [0.0]
    for i in range(1, n):
        diff = closes[i] - closes[i - 1]
        gains.append(diff if diff > 0 else 0.0)
        losses.append(-diff if diff < 0 else 0.0)
    avg_gain = sum(gains[1:period + 1]) / period
    avg_loss = sum(losses[1:period + 1]) / period
    out: list[float] = [50.0] * (period)
    rs = (avg_gain / avg_loss) if avg_loss > 0 else 0.0
    out.append(100 - 100 / (1 + rs) if avg_loss > 0 else 100.0)
    for i in range(period + 1, n):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rs = (avg_gain / avg_loss) if avg_loss > 0 else 0.0
        out.append(100 - 100 / (1 + rs) if avg_loss > 0 else 100.0)
    return out[:n]


def _macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[list[float], list[float], list[float]]:
    """Standard MACD (12, 26, 9). Returns (line, signal, histogram).

    line  = EMA(fast) - EMA(slow)         — momentum direction + magnitude
    signal = EMA(line, 9)                 — smoothed line, used for crossovers
    hist  = line - signal                 — bar-style momentum, zero-cross = signal flip
    """
    if len(closes) < slow + signal:
        return [0.0] * len(closes), [0.0] * len(closes), [0.0] * len(closes)
    ef, es = _ema(closes, fast), _ema(closes, slow)
    line = [ef[i] - es[i] for i in range(len(closes))]
    sig = _ema(line, signal)
    hist = [line[i] - sig[i] for i in range(len(closes))]
    return line, sig, hist


def _bbands(closes: list[float], period: int = 20, std_mult: float = 2.0) -> tuple[list[float], list[float], list[float]]:
    """Bollinger Bands (20, 2σ). Returns (upper, mid, lower).

    mid = SMA(20).  upper/lower = mid ± std_mult × rolling stdev.
    Bandwidth = (upper - lower) / mid is a volatility gauge — squeezes
    (low BW) often precede breakouts. Position within bands (0..1) is also
    useful: >0.95 = near upper band (mean-revert short), <0.05 = near lower
    band (mean-revert long).
    """
    n = len(closes)
    if n < period:
        return [0.0] * n, list(closes), [0.0] * n
    upper, mid, lower = [0.0] * n, [0.0] * n, [0.0] * n
    for i in range(n):
        if i < period - 1:
            mid[i] = sum(closes[: i + 1]) / (i + 1)
            upper[i] = lower[i] = mid[i]
            continue
        window = closes[i - period + 1 : i + 1]
        m = sum(window) / period
        var = sum((x - m) ** 2 for x in window) / period
        sd = var ** 0.5
        mid[i] = m
        upper[i] = m + std_mult * sd
        lower[i] = m - std_mult * sd
    return upper, mid, lower


def _overkill_signal(
    price: float,
    e9: float | None,
    e21: float | None,
    e50: float | None,
    e200: float | None,
    mode: str = "swing",
) -> tuple[str, str]:
    """Overkill-style read: buy near/below rising MAs, sell when price trades at a premium.

    Two flavours:
    - swing (default): full daily setup with 9/21/50/200 EMAs, 1.5% near-MA
      window and 8% premium threshold.  Slow-moving but high-confidence.
    - day: intraday 15m bars, 9/21/50 EMAs only (200 needs 200 bars and we
      only have ~480 of 15m), tighter 1% near-MA window and 5% premium
      so signals fire on the actual moves day traders care about.
    """
    if mode == "day":
        if None in (e9, e21, e50):
            return "HOLD", "Not enough 15m bars for intraday EMAs"
        stack_bull = e9 > e21 > e50  # type: ignore[operator]
        stack_bear = e9 < e21 < e50  # type: ignore[operator]
        near_ma = abs(price - e21) / price <= 0.01           # 1% (tighter)
        premium = price > e21 * 1.05                         # 5% (tighter)
        if stack_bull and near_ma:
            return "BUY", "Intraday: bullish stack (9>21>50) at 21 EMA — entry"
        if stack_bull and premium:
            return "SELL", "Intraday: extended >5% above 21 EMA — take profit"
        if stack_bear and price > e21:                       # type: ignore[operator]
            return "SELL", "Intraday: bearish stack, price bouncing into 21 EMA"
        if stack_bull:
            return "HOLD", "Intraday bullish — wait for pullback"
        if stack_bear:
            return "HOLD", "Intraday bearish — no new longs"
        return "HOLD", "Intraday: mixed EMAs"

    # swing
    if None in (e9, e21, e50, e200):
        return "HOLD", "Not enough history for EMAs"
    stack_bull = e9 > e21 > e50 > e200  # type: ignore[operator]
    stack_bear = e9 < e21 < e50 < e200  # type: ignore[operator]
    near_ma = abs(price - e21) / price <= 0.015
    premium = price > e21 * 1.08
    if stack_bull and near_ma:
        return "BUY", "Bullish EMA stack (9>21>50>200) and price near 21 EMA"
    if stack_bull and premium:
        return "SELL", "Bullish stack but price extended >8% above 21 EMA (take profit)"
    if stack_bear and price > e21:  # type: ignore[operator]
        return "SELL", "Bearish EMA stack and price bouncing into 21 EMA"
    if stack_bull:
        return "HOLD", "Bullish stack, wait for pullback to 21 EMA"
    if stack_bear:
        return "HOLD", "Bearish stack — avoid new longs"
    return "HOLD", "Mixed EMAs — no clean setup"


# ---------------------------------------------------------------------------
# Custom thesis DSL — per-coin BUY/SELL rules layered on top of Overkill
# ---------------------------------------------------------------------------

# Whitelist enforced on every POST and at evaluation time — never `eval`.
_THESIS_INDICATORS = {
    "price", "rsi", "ema9", "ema21", "ema50", "ema200",
    "macd", "macd_signal", "macd_hist",
    "atr", "atr_pct", "rvol",
    "pct_24h", "price_vs_ema21",
    "bb_upper", "bb_mid", "bb_lower", "bb_pct", "bb_width",
}
_THESIS_OPS = {"lt", "gt", "lte", "gte", "eq",
               "crosses_above", "crosses_below"}


def _indicator_value(name: str, q) -> float | None:
    """Resolve an indicator name to a Quote field (with derived fallbacks)."""
    if name == "pct_24h":
        return q.change_pct
    if name == "price_vs_ema21":
        if q.ema21 and q.price:
            return (q.price - q.ema21) / q.ema21 * 100.0
        return None
    return getattr(q, name, None)


def _evaluate_cond(cond: dict, q, prev_q) -> bool:
    ind = cond.get("indicator")
    op  = cond.get("op")
    try:
        target = float(cond.get("value"))
    except (TypeError, ValueError):
        return False
    if ind not in _THESIS_INDICATORS or op not in _THESIS_OPS:
        return False
    cur = _indicator_value(ind, q)
    if cur is None:
        return False
    if op == "lt":  return cur <  target
    if op == "gt":  return cur >  target
    if op == "lte": return cur <= target
    if op == "gte": return cur >= target
    if op == "eq":  return abs(cur - target) < 1e-9
    # cross conditions need the previous snapshot
    if prev_q is None:
        return False
    prev = _indicator_value(ind, prev_q)
    if prev is None:
        return False
    if op == "crosses_above": return prev <= target and cur > target
    if op == "crosses_below": return prev >= target and cur < target
    return False


def _evaluate_rule_group(group: dict, q, prev_q) -> bool:
    """A rule group = {logic: AND|OR, conds: [...]}.  Fires when the logic
    fold over its conditions is true."""
    if not isinstance(group, dict):
        return False
    conds = group.get("conds") or []
    if not conds:
        return False
    logic = (group.get("logic") or "AND").upper()
    results = [_evaluate_cond(c, q, prev_q) for c in conds if isinstance(c, dict)]
    if not results:
        return False
    return all(results) if logic == "AND" else any(results)


def _evaluate_thesis(row: dict, q, prev_q) -> tuple[str, str] | None:
    """Returns ('BUY', name) or ('SELL', name) on a hit; None otherwise.
    BUY checked before SELL — a thesis shouldn't fire both at once."""
    try:
        buys  = json.loads(row.get("buy_rules")  or "[]") or []
        sells = json.loads(row.get("sell_rules") or "[]") or []
    except json.JSONDecodeError:
        return None
    name = row.get("name") or "thesis"
    for grp in buys:
        if _evaluate_rule_group(grp, q, prev_q):
            return "BUY", name
    for grp in sells:
        if _evaluate_rule_group(grp, q, prev_q):
            return "SELL", name
    return None


def _validate_thesis_rules(rules) -> str | None:
    """Reject anything outside the whitelist BEFORE storing.  Returns an error
    string on failure, None on success."""
    if not isinstance(rules, list):
        return "rules must be a JSON array"
    for i, grp in enumerate(rules):
        if not isinstance(grp, dict):
            return f"rule #{i+1} must be an object"
        logic = (grp.get("logic") or "AND").upper()
        if logic not in ("AND", "OR"):
            return f"rule #{i+1}: logic must be AND or OR"
        conds = grp.get("conds")
        if not isinstance(conds, list) or not conds:
            return f"rule #{i+1}: conds must be a non-empty array"
        for j, c in enumerate(conds):
            if not isinstance(c, dict):
                return f"rule #{i+1} cond #{j+1} must be an object"
            if c.get("indicator") not in _THESIS_INDICATORS:
                return f"rule #{i+1} cond #{j+1}: unknown indicator '{c.get('indicator')}'"
            if c.get("op") not in _THESIS_OPS:
                return f"rule #{i+1} cond #{j+1}: unknown op '{c.get('op')}'"
            try:
                float(c.get("value"))
            except (TypeError, ValueError):
                return f"rule #{i+1} cond #{j+1}: value must be a number"
    return None


def _load_theses(db, pid: int, symbol: str | None = None) -> list[dict]:
    if symbol:
        rows = db.execute(
            "SELECT id, symbol, name, buy_rules, sell_rules, notes, enabled, "
            "last_fired_signal, last_fired_at, created_at, updated_at "
            "FROM coin_theses WHERE portfolio_id = ? AND symbol = ? "
            "ORDER BY id DESC",
            (pid, symbol),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id, symbol, name, buy_rules, sell_rules, notes, enabled, "
            "last_fired_signal, last_fired_at, created_at, updated_at "
            "FROM coin_theses WHERE portfolio_id = ? ORDER BY symbol, id DESC",
            (pid,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["buy_rules"]  = json.loads(d.get("buy_rules")  or "[]")
            d["sell_rules"] = json.loads(d.get("sell_rules") or "[]")
        except json.JSONDecodeError:
            d["buy_rules"], d["sell_rules"] = [], []
        d["enabled"] = bool(d.get("enabled"))
        out.append(d)
    return out


# Module-level cache: lets _signal_watcher_loop see the previous Quote so
# `crosses_above/below` conditions can compare last-tick vs this-tick.
_prev_quotes: dict[str, "Quote"] = {}


def _demo_history(symbol: str) -> tuple[list[str], list[float], list[float], list[float], list[float], str, str]:
    """Deterministic synthetic OHLC + volume history for offline/demo use."""
    seed = int(hashlib.sha256(symbol.encode()).hexdigest(), 16) % (2**32)
    rng = random.Random(seed)
    base = 50 + rng.random() * 900
    n = 260
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    volumes: list[float] = []
    p = base
    drift = (rng.random() - 0.4) * 0.0008
    base_vol = 1_000_000 + rng.random() * 50_000_000
    for _ in range(n):
        shock = rng.gauss(0, 0.018)
        p = max(1.0, p * (1 + drift + shock))
        closes.append(p)
        intraday = abs(rng.gauss(0, 0.012)) + 0.004
        highs.append(p * (1 + intraday))
        lows.append(p * (1 - intraday))
        # Volume scales with intraday range — bigger moves get bigger volume
        volumes.append(base_vol * (1 + abs(shock) * 8) * (0.7 + rng.random() * 0.6))
    today = datetime.now(timezone.utc).date()
    dates = [(today - timedelta(days=n - 1 - i)).strftime("%Y-%m-%d") for i in range(n)]
    currency = "USD"
    name = f"{symbol} (demo)"
    return dates, highs, lows, closes, volumes, currency, name


def _coingecko_history(coin_id: str, days: int = 365) -> tuple[list[str], list[float], list[float], list[float], list[float], str, str] | None:
    """Pull candles from CoinGecko free tier (no key).

    /market_chart granularity is implicit:
      days=1               → 5-minute bars  (~288 of them — perfect for day mode)
      days in [2, 90]      → hourly bars
      days > 90            → daily bars     (used for swing mode)

    There's no high/low at this granularity on the free plan, so we approximate
    the daily range with ±0.6% of close.  EMAs and signal logic are close-based,
    so the only real impact is on ATR — which slightly understates volatility.
    """
    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days={days}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        app.logger.warning("CoinGecko fetch failed for %s: %s", coin_id, exc)
        return None

    prices = payload.get("prices") or []
    if len(prices) < 30:  # need enough bars to compute meaningful EMAs
        return None
    # Date format depends on granularity: intraday gets HH:MM, daily gets a
    # bare date.  When days <= 90 the response is sub-daily so multiple ticks
    # per day are expected and we keep them all.
    intraday = days <= 90
    fmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    dates: list[str] = []
    closes: list[float] = []
    seen_keys: dict[str, int] = {}
    for ts_ms, px in prices:
        d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(fmt)
        prev_idx = seen_keys.get(d)
        if prev_idx is not None:
            closes[prev_idx] = float(px)
            continue
        seen_keys[d] = len(dates)
        dates.append(d)
        closes.append(float(px))
    # Volumes — the same /market_chart payload returns total_volumes[ts, vol]
    volume_by_date: dict[str, float] = {}
    for ts_ms, vol in (payload.get("total_volumes") or []):
        d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(fmt)
        volume_by_date[d] = float(vol)
    volumes = [volume_by_date.get(d, 0.0) for d in dates]
    # Synthetic high/low band for ATR (kept tight so we don't fabricate volatility).
    highs = [c * 1.006 for c in closes]
    lows  = [c * 0.994 for c in closes]
    name = coin_id.replace("-", " ").title()
    # Best-effort proper name via /coins/{id} — non-fatal.
    try:
        meta_url = (
            f"https://api.coingecko.com/api/v3/coins/{coin_id}"
            "?localization=false&tickers=false&market_data=false"
            "&community_data=false&developer_data=false&sparkline=false"
        )
        req2 = urllib.request.Request(meta_url, headers={"User-Agent": "ChurnLence/1.0"})
        with urllib.request.urlopen(req2, timeout=8) as resp:
            meta = json.loads(resp.read())
        name = meta.get("name") or name
    except Exception:
        pass
    return dates, highs, lows, closes, volumes, "USD", name


def fetch_quote(symbol: str, force: bool = False, mode: str = "swing") -> Quote | None:
    """Pull a quote with EMA/ATR/signal in either swing or day-trade flavour.

    mode="swing" (default): 1-year daily candles, EMA 9/21/50/200, 2×ATR stop.
    mode="day":             5-day 15-minute candles (or 5-min on CoinGecko),
                            EMA 9/21/50, 1×ATR stop, tighter signal thresholds.
    """
    symbol = symbol.upper().strip()
    mode = (mode or "swing").lower()
    if mode not in ("swing", "day"):
        mode = "swing"
    if not symbol:
        return None
    cache_key = f"{symbol}:{mode}"
    now = time.time()
    # Day-mode prices move faster; halve the cache TTL so we re-check sooner.
    ttl = QUOTE_TTL // 2 if mode == "day" else QUOTE_TTL
    with _quote_lock:
        cached = _quote_cache.get(cache_key)
        if cached and not force and now - cached[0] < ttl:
            return Quote(**cached[1])

    dates: list[str] = []
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    currency = "USD"
    name = symbol
    ticker = None

    # yfinance period/interval per mode
    yf_period, yf_interval = ("1y", "1d") if mode == "swing" else ("5d", "15m")

    volumes: list[float] = []

    if not DEMO_MODE:
        try:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period=yf_period, interval=yf_interval, auto_adjust=False)
            if not hist.empty:
                closes = [float(x) for x in hist["Close"].tolist()]
                highs = [float(x) for x in hist["High"].tolist()]
                lows = [float(x) for x in hist["Low"].tolist()]
                volumes = [float(x) for x in hist.get("Volume", []).tolist()] if "Volume" in hist.columns else []
                fmt = "%Y-%m-%d" if mode == "swing" else "%Y-%m-%d %H:%M"
                dates = [d.strftime(fmt) for d in hist.index]
        except Exception as exc:
            app.logger.warning("yfinance history failed for %s [%s]: %s", symbol, mode, exc)

    used_coingecko = False
    if not closes and not DEMO_MODE:
        cg_id = COINGECKO_MAP.get(symbol)
        if cg_id:
            cg = _coingecko_history(cg_id, days=(1 if mode == "day" else 365))
            if cg:
                dates, highs, lows, closes, volumes, currency, name = cg
                used_coingecko = True

    if not closes:
        if DEMO_MODE:
            dates, highs, lows, closes, volumes, currency, name = _demo_history(symbol)
        else:
            return None

    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    ema50 = _ema(closes, 50)
    ema200 = _ema(closes, 200) if mode == "swing" else []
    atr_series = _atr(highs, lows, closes, 14) if highs and lows else []
    rsi_series = _rsi(closes, 14)
    macd_line, macd_sig, macd_hist = _macd(closes)
    bb_up, bb_mid, bb_lo = _bbands(closes)

    price = closes[-1]
    prev_close = closes[-2] if len(closes) > 1 else price
    change = price - prev_close
    change_pct = (change / prev_close * 100) if prev_close else 0.0

    if not DEMO_MODE and not used_coingecko:
        try:
            fast = ticker.fast_info
            live = float(getattr(fast, "last_price", None) or fast.get("lastPrice") or 0) or None
            if live:
                change = live - prev_close
                change_pct = (change / prev_close * 100) if prev_close else 0.0
                price = live
            currency = getattr(fast, "currency", None) or fast.get("currency") or currency
        except Exception:
            pass
        try:
            name = ticker.info.get("shortName") or ticker.info.get("longName") or symbol
        except Exception:
            name = symbol
    else:
        jitter = random.uniform(-0.006, 0.006)
        price = max(0.01, price * (1 + jitter))
        change = price - prev_close
        change_pct = (change / prev_close * 100) if prev_close else 0.0

    e9   = ema9[-1] if ema9 else None
    e21  = ema21[-1] if ema21 else None
    e50  = ema50[-1] if len(ema50) >= 50 else None
    e200 = ema200[-1] if len(ema200) >= 200 else None
    atr_last = atr_series[-1] if atr_series else None
    atr_pct  = (atr_last / price * 100) if (atr_last and price) else None
    rsi_last = rsi_series[-1] if rsi_series else None
    if rsi_last is None:
        rsi_label = "neutral"
    elif rsi_last >= 70:
        rsi_label = "overbought"
    elif rsi_last <= 30:
        rsi_label = "oversold"
    else:
        rsi_label = "neutral"
    macd_last = macd_line[-1] if macd_line else None
    macd_sig_last = macd_sig[-1] if macd_sig else None
    macd_hist_last = macd_hist[-1] if macd_hist else None
    bb_up_last = bb_up[-1] if bb_up else None
    bb_mid_last = bb_mid[-1] if bb_mid else None
    bb_lo_last = bb_lo[-1] if bb_lo else None
    # %B: where current price sits within the bands (0 = lower, 1 = upper)
    bb_pct = None
    if bb_up_last is not None and bb_lo_last is not None and bb_up_last > bb_lo_last:
        bb_pct = (price - bb_lo_last) / (bb_up_last - bb_lo_last)
    # Bandwidth as a % of mid; <0.04 is a tight squeeze
    bb_width = None
    if bb_mid_last and bb_up_last is not None and bb_lo_last is not None:
        bb_width = (bb_up_last - bb_lo_last) / bb_mid_last
    # Relative volume: last bar's volume vs 20-bar average.
    # >1.5 = above average, >3 = unusual buying.  Falls back to 1.0 if we
    # don't have at least 20 bars of clean data.
    last_volume = volumes[-1] if volumes else None
    rvol = None
    rvol_label = "normal"
    if volumes and len(volumes) >= 21:
        prior20 = volumes[-21:-1]
        prior_clean = [v for v in prior20 if v and v > 0]
        if prior_clean:
            avg20 = sum(prior_clean) / len(prior_clean)
            if avg20 > 0 and last_volume:
                rvol = round(last_volume / avg20, 2)
                if rvol >= 3:
                    rvol_label = "unusual"
                elif rvol >= 1.5:
                    rvol_label = "high"
                elif rvol <= 0.5:
                    rvol_label = "low"
                else:
                    rvol_label = "normal"
    # Tighter stops in day mode: 1% under EMA21 and 1×ATR (vs 3% / 2×ATR swing).
    if mode == "day":
        stop_ma  = round(e21 * 0.99, 6) if e21 else None
        stop_atr = round(price - atr_last * 1.0, 6) if atr_last else None
    else:
        stop_ma  = round(e21 * 0.97, 4) if e21 else None
        stop_atr = round(price - atr_last * 2.0, 4) if atr_last else None
    signal, reason = _overkill_signal(price, e9, e21, e50, e200, mode=mode)

    history = []
    take = min(180, len(closes))
    for i in range(len(closes) - take, len(closes)):
        history.append({
            "date": dates[i],
            "close": round(closes[i], 4),
            "ema9":  round(ema9[i], 4)   if ema9 else None,
            "ema21": round(ema21[i], 4)  if ema21 else None,
            "ema50": round(ema50[i], 4)  if (ema50 and i >= 49) else None,
            "ema200": round(ema200[i], 4) if (ema200 and i >= 199) else None,
            "atr":   round(atr_series[i], 4) if atr_series else None,
            "rsi":   round(rsi_series[i], 1) if rsi_series else None,
            "macd":         round(macd_line[i], 4) if macd_line else None,
            "macd_signal":  round(macd_sig[i],  4) if macd_sig  else None,
            "macd_hist":    round(macd_hist[i], 4) if macd_hist else None,
            "bb_upper": round(bb_up[i],  4) if bb_up  else None,
            "bb_mid":   round(bb_mid[i], 4) if bb_mid else None,
            "bb_lower": round(bb_lo[i],  4) if bb_lo  else None,
        })

    quote = Quote(
        symbol=symbol,
        price=round(price, 4),
        change=round(change, 4),
        change_pct=round(change_pct, 3),
        currency=currency,
        name=name,
        ema9=round(e9, 4) if e9 else None,
        ema21=round(e21, 4) if e21 else None,
        ema50=round(e50, 4) if e50 else None,
        ema200=round(e200, 4) if e200 else None,
        atr=round(atr_last, 4) if atr_last else None,
        atr_pct=round(atr_pct, 3) if atr_pct else None,
        rsi=round(rsi_last, 1) if rsi_last is not None else None,
        rsi_label=rsi_label,
        macd=round(macd_last, 4) if macd_last is not None else None,
        macd_signal=round(macd_sig_last, 4) if macd_sig_last is not None else None,
        macd_hist=round(macd_hist_last, 4) if macd_hist_last is not None else None,
        bb_upper=round(bb_up_last, 4) if bb_up_last is not None else None,
        bb_mid=round(bb_mid_last, 4) if bb_mid_last is not None else None,
        bb_lower=round(bb_lo_last, 4) if bb_lo_last is not None else None,
        bb_pct=round(bb_pct, 3) if bb_pct is not None else None,
        bb_width=round(bb_width, 4) if bb_width is not None else None,
        volume_24h=round(last_volume, 2) if last_volume else None,
        rvol=rvol,
        rvol_label=rvol_label,
        stop_loss=stop_ma,
        stop_atr=stop_atr,
        signal=signal,
        signal_reason=reason,
        history=history,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )

    with _quote_lock:
        _quote_cache[cache_key] = (now, quote.as_dict())
    return quote


# ---------------------------------------------------------------------------
# Portfolio math
# ---------------------------------------------------------------------------

def _concentration(rows: list[dict], total_value: float) -> dict:
    """Herfindahl-Hirschman Index + threshold-based warnings."""
    if total_value <= 0:
        return {"hhi": 0, "grade": "—", "warnings": [], "top_weight": 0.0}
    weights = []
    for r in rows:
        v = r.get("value") or 0
        if v <= 0:
            continue
        w_pct = v / total_value * 100
        weights.append((r["symbol"], w_pct))
    hhi = round(sum((w * w) for _, w in weights), 1)
    if hhi < 1500:
        grade = "Well diversified"
    elif hhi < 2500:
        grade = "Moderately concentrated"
    else:
        grade = "Highly concentrated"
    warnings: list[dict] = []
    for sym, w in sorted(weights, key=lambda x: -x[1]):
        if w > 10:
            warnings.append({"symbol": sym, "weight": round(w, 2),
                             "message": f"{sym} is {w:.1f}% of the portfolio (>10% single-name risk)"})
    top_weight = max((w for _, w in weights), default=0.0)
    return {
        "hhi": hhi,
        "grade": grade,
        "warnings": warnings,
        "top_weight": round(top_weight, 2),
        "positions": len(weights),
    }


def _position_size(symbol: str, account: float, risk_pct: float,
                   stop_method: str, custom_stop: float | None = None,
                   atr_multiplier: float = 2.0) -> dict:
    """Compute share count for a given account size, risk %, and stop method.

    stop_method: "atr" | "ma" | "custom"
    """
    q = fetch_quote(symbol)
    if q is None:
        return {"error": f"symbol {symbol} not found"}
    if account <= 0 or risk_pct <= 0 or risk_pct > 100:
        return {"error": "account must be > 0 and 0 < risk_pct <= 100"}
    risk_dollars = account * (risk_pct / 100)

    price = q.price or 0
    if stop_method == "atr":
        if q.atr is None:
            return {"error": "ATR not available for this symbol"}
        stop = price - q.atr * atr_multiplier
        stop_label = f"price − {atr_multiplier}×ATR"
    elif stop_method == "ma":
        if q.stop_loss is None:
            return {"error": "MA stop not available — need EMA21"}
        stop = q.stop_loss
        stop_label = "EMA21 × 0.97"
    elif stop_method == "custom":
        if custom_stop is None or custom_stop >= price:
            return {"error": "custom_stop must be below current price"}
        stop = custom_stop
        stop_label = "custom"
    else:
        return {"error": "stop_method must be atr|ma|custom"}

    distance = price - stop
    if distance <= 0:
        return {"error": "stop is not below price — refusing to size"}
    shares = risk_dollars / distance
    position_value = shares * price
    pct_of_account = position_value / account * 100
    return {
        "symbol": q.symbol,
        "price": price,
        "atr": q.atr,
        "atr_pct": q.atr_pct,
        "stop": round(stop, 4),
        "stop_label": stop_label,
        "stop_distance": round(distance, 4),
        "stop_distance_pct": round(distance / price * 100, 3),
        "risk_dollars": round(risk_dollars, 2),
        "shares": round(shares, 4),
        "position_value": round(position_value, 2),
        "pct_of_account": round(pct_of_account, 2),
        "exceeds_account": position_value > account,
        "signal": q.signal,
        "signal_reason": q.signal_reason,
        "rsi": q.rsi,
        "rsi_label": q.rsi_label,
        "rvol": q.rvol,
        "rvol_label": q.rvol_label,
    }


def _kelly_size(win_rate: float, avg_win_pct: float, avg_loss_pct: float,
                account: float, fraction: float = 0.5) -> dict:
    """Kelly criterion: f* = w - (1-w)/R where R = avg_win / avg_loss.

    win_rate     ∈ [0, 1]
    avg_win_pct  > 0 (e.g. 0.15 for 15%)
    avg_loss_pct > 0 (always entered as positive — function flips sign)
    fraction     "Kelly fraction" — full Kelly is too aggressive for most.
                 Default 0.5 = "half-Kelly", widely used in practice.

    Returns the % of account to bet per trade and the dollar amount.
    """
    if avg_loss_pct <= 0:
        return {"error": "avg_loss_pct must be > 0"}
    R = avg_win_pct / avg_loss_pct
    f_star = win_rate - (1 - win_rate) / R
    f_used = max(0.0, f_star * fraction)
    return {
        "win_rate":      round(win_rate * 100, 2),
        "avg_win_pct":   round(avg_win_pct * 100, 2),
        "avg_loss_pct":  round(avg_loss_pct * 100, 2),
        "payoff_ratio":  round(R, 3),
        "kelly_full":    round(f_star * 100, 2),
        "kelly_used":    round(f_used * 100, 2),
        "fraction":      fraction,
        "bet_dollars":   round(f_used * account, 2),
        "warning":       (
            "Kelly is negative — your strategy has no edge over this window. "
            "Don't trade." if f_star <= 0 else
            "Full Kelly is dangerously volatile. Use half-Kelly (default) "
            "or quarter-Kelly until you trust the win-rate." if fraction == 1 else
            None
        ),
    }


@app.route("/api/portfolios/<int:pid>/kelly")
def kelly_route(pid: int):
    """Compute Kelly bet sizing using the user's recent realized trades.

    Falls back to backtest stats on a chosen symbol when there aren't enough
    closed trades yet."""
    try:
        account = float(request.args.get("account") or 10000)
        fraction = float(request.args.get("fraction") or 0.5)
    except ValueError:
        return jsonify({"error": "invalid numeric input"}), 400
    fraction = max(0.1, min(fraction, 1.0))
    db = get_db()
    txs = db.execute(
        "SELECT shares, sell_price, cost_basis, realized_pl FROM transactions "
        "WHERE portfolio_id = ? ORDER BY sold_at DESC LIMIT 50",
        (pid,),
    ).fetchall()
    if len(txs) < 5:
        return jsonify({
            "error": "need at least 5 realized sells to estimate win-rate. "
                     "Use the backtest tab on a single symbol instead.",
            "trades_available": len(txs),
        }), 400
    wins, losses = [], []
    for t in txs:
        cost = float(t["cost_basis"])
        sell = float(t["sell_price"])
        if cost <= 0:
            continue
        ret = (sell - cost) / cost
        if ret > 0:
            wins.append(ret)
        else:
            losses.append(-ret)
    if not wins or not losses:
        return jsonify({"error": "need both winning and losing trades to compute Kelly"}), 400
    win_rate = len(wins) / (len(wins) + len(losses))
    avg_win = sum(wins) / len(wins)
    avg_loss = sum(losses) / len(losses)
    out = _kelly_size(win_rate, avg_win, avg_loss, account, fraction)
    out["sample"] = {"wins": len(wins), "losses": len(losses), "trades": len(wins) + len(losses)}
    return jsonify(out)


def _portfolio_snapshot(portfolio_id: int, mode: str = "swing") -> dict:
    with direct_db() as db:
        portfolio = db.execute("SELECT id, name FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone()
        if not portfolio:
            return {"error": "portfolio not found"}
        holdings = db.execute(
            "SELECT id, symbol, shares, cost_basis, note FROM holdings WHERE portfolio_id = ? ORDER BY symbol",
            (portfolio_id,),
        ).fetchall()
        # Pull theses once and group by symbol so we can attach to rows.
        theses_by_sym: dict[str, list[dict]] = {}
        for t in _load_theses(db, portfolio_id):
            theses_by_sym.setdefault(t["symbol"], []).append({
                "id": t["id"], "name": t["name"], "enabled": t["enabled"],
                "last_fired_signal": t.get("last_fired_signal"),
            })
        watch_rows = db.execute(
            "SELECT symbol FROM watchlist WHERE portfolio_id = ? ORDER BY symbol",
            (portfolio_id,),
        ).fetchall()
        watchlist_syms = [r["symbol"] for r in watch_rows]

    rows = []
    total_value = 0.0
    total_cost = 0.0
    total_day_change = 0.0
    for h in holdings:
        q = fetch_quote(h["symbol"], mode=mode)
        shares = float(h["shares"])
        cost = float(h["cost_basis"])
        if q is None:
            rows.append({
                "id": h["id"], "symbol": h["symbol"], "shares": shares, "cost_basis": cost,
                "note": h["note"], "error": "No data",
            })
            continue
        value = q.price * shares
        cost_total = cost * shares
        pl = value - cost_total
        pl_pct = (pl / cost_total * 100) if cost_total else 0.0
        day_pl = q.change * shares
        total_value += value
        total_cost += cost_total
        total_day_change += day_pl
        rows.append({
            "id": h["id"],
            "symbol": q.symbol,
            "name": q.name,
            "shares": shares,
            "cost_basis": cost,
            "price": q.price,
            "currency": q.currency,
            "change": q.change,
            "change_pct": q.change_pct,
            "value": round(value, 2),
            "cost_total": round(cost_total, 2),
            "pl": round(pl, 2),
            "pl_pct": round(pl_pct, 3),
            "day_pl": round(day_pl, 2),
            "ema9": q.ema9,
            "ema21": q.ema21,
            "ema50": q.ema50,
            "ema200": q.ema200,
            "atr": q.atr,
            "atr_pct": q.atr_pct,
            "rsi": q.rsi,
            "rsi_label": q.rsi_label,
            "macd": q.macd,
            "macd_signal": q.macd_signal,
            "macd_hist": q.macd_hist,
            "bb_pct": q.bb_pct,
            "bb_width": q.bb_width,
            "volume_24h": q.volume_24h,
            "rvol": q.rvol,
            "rvol_label": q.rvol_label,
            "stop_loss": q.stop_loss,
            "stop_atr": q.stop_atr,
            "signal": q.signal,
            "signal_reason": q.signal_reason,
            "note": h["note"],
            "theses": theses_by_sym.get(q.symbol, []),
        })

    concentration = _concentration(rows, total_value)
    total_pl = total_value - total_cost
    total_pl_pct = (total_pl / total_cost * 100) if total_cost else 0.0
    return {
        "portfolio": {"id": portfolio["id"], "name": portfolio["name"]},
        "rows": rows,
        "concentration": concentration,
        "totals": {
            "value": round(total_value, 2),
            "cost": round(total_cost, 2),
            "pl": round(total_pl, 2),
            "pl_pct": round(total_pl_pct, 3),
            "day_pl": round(total_day_change, 2),
        },
        "watchlist": watchlist_syms,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/portfolios", methods=["GET", "POST"])
def portfolios():
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name is required"}), 400
        try:
            cur = db.execute("INSERT INTO portfolios(name) VALUES (?)", (name,))
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "portfolio exists"}), 409
        return jsonify({"id": cur.lastrowid, "name": name}), 201
    rows = db.execute("SELECT id, name FROM portfolios ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/portfolios/<int:pid>", methods=["DELETE", "PATCH"])
def portfolio_detail(pid: int):
    db = get_db()
    if request.method == "DELETE":
        # Refuse to delete the last portfolio — always keep at least one.
        remaining = db.execute("SELECT COUNT(*) FROM portfolios").fetchone()[0]
        if remaining <= 1:
            return jsonify({"error": "cannot delete the last portfolio"}), 400
        db.execute("DELETE FROM portfolios WHERE id = ?", (pid,))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        db.execute("UPDATE portfolios SET name = ? WHERE id = ?", (name, pid))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "name already in use"}), 409
    return jsonify({"id": pid, "name": name})


@app.route("/api/portfolios/<int:pid>/holdings", methods=["GET", "POST"])
def holdings(pid: int):
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        symbol = (data.get("symbol") or "").upper().strip()
        try:
            shares = float(data.get("shares"))
            cost = float(data.get("cost_basis"))
        except (TypeError, ValueError):
            return jsonify({"error": "shares and cost_basis must be numbers"}), 400
        note = (data.get("note") or "").strip() or None
        if not symbol or shares <= 0 or cost < 0:
            return jsonify({"error": "invalid input"}), 400
        # Validate ticker exists
        if fetch_quote(symbol) is None:
            return jsonify({"error": f"symbol {symbol} not found"}), 404
        cur = db.execute(
            "INSERT INTO holdings(portfolio_id, symbol, shares, cost_basis, note) VALUES (?, ?, ?, ?, ?)",
            (pid, symbol, shares, cost, note),
        )
        db.commit()
        return jsonify({"id": cur.lastrowid}), 201
    mode = (request.args.get("mode") or "swing").lower()
    return jsonify(_portfolio_snapshot(pid, mode=mode))


@app.route("/api/holdings/<int:hid>", methods=["PATCH", "DELETE"])
def holding_detail(hid: int):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM holdings WHERE id = ?", (hid,))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json(force=True, silent=True) or {}
    fields, values = [], []
    for key in ("shares", "cost_basis", "note"):
        if key in data:
            fields.append(f"{key} = ?")
            values.append(data[key])
    if not fields:
        return jsonify({"error": "no fields"}), 400
    values.append(hid)
    db.execute(f"UPDATE holdings SET {', '.join(fields)} WHERE id = ?", values)
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/quote/<symbol>")
def quote(symbol: str):
    mode = (request.args.get("mode") or "swing").lower()
    q = fetch_quote(symbol, force=request.args.get("force") == "1", mode=mode)
    if q is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(q.as_dict())


@app.route("/api/search")
def search():
    """Crypto-only autocomplete from the curated SYMBOL_UNIVERSE.
    Falls back to a CoinGecko search for unknown symbols so brand-new
    listings still resolve."""
    q = (request.args.get("q") or "").upper().strip()
    if not q:
        return jsonify([])
    prefix, substring = [], []
    for item in SYMBOL_UNIVERSE:
        sym = item["symbol"]
        name = item["name"].upper()
        if sym.startswith(q) or name.startswith(q):
            prefix.append(item)
        elif q in sym or q in name:
            substring.append(item)
    out = (prefix + substring)[:10]
    if not out and not DEMO_MODE:
        # Try CoinGecko's /search — accurate for fresh tokens.
        try:
            url = f"https://api.coingecko.com/api/v3/search?query={q.lower()}"
            req = urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"})
            with urllib.request.urlopen(req, timeout=4) as r:
                payload = json.loads(r.read())
            for coin in (payload.get("coins") or [])[:5]:
                sym = (coin.get("symbol") or "").upper() + "-USD"
                out.append({
                    "symbol": sym,
                    "name": coin.get("name") or sym,
                    "kind": "crypto",
                    "_coingecko_id": coin.get("id"),
                })
        except Exception:
            pass
    return jsonify(out)


@app.route("/api/presets")
def presets():
    return jsonify([
        {"id": key, **value} for key, value in PRESET_BASKETS.items()
    ])


@app.route("/api/portfolios/<int:pid>/holdings/bulk", methods=["POST"])
def bulk_holdings(pid: int):
    """Bulk-add. Body: {items: [{symbol, shares, cost_basis}, ...]}
    If cost_basis is omitted or 0, current price is used."""
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items") or []
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items must be a non-empty list"}), 400
    db = get_db()
    added, errors = [], []
    for item in items:
        symbol = str(item.get("symbol") or "").upper().strip()
        try:
            shares = float(item.get("shares", 1))
        except (TypeError, ValueError):
            shares = 1.0
        cost_raw = item.get("cost_basis")
        q = fetch_quote(symbol)
        if q is None or not symbol:
            errors.append({"symbol": symbol, "error": "not found"})
            continue
        try:
            cost = float(cost_raw) if cost_raw not in (None, "") else q.price
        except (TypeError, ValueError):
            cost = q.price
        if shares <= 0 or cost < 0:
            errors.append({"symbol": symbol, "error": "invalid shares/cost"})
            continue
        cur = db.execute(
            "INSERT INTO holdings(portfolio_id, symbol, shares, cost_basis, note) VALUES (?, ?, ?, ?, ?)",
            (pid, symbol, shares, cost, item.get("note")),
        )
        added.append({"id": cur.lastrowid, "symbol": symbol, "shares": shares, "cost_basis": cost})
    db.commit()
    return jsonify({"added": added, "errors": errors})


@app.route("/api/position-size", methods=["POST"])
def position_size_route():
    data = request.get_json(force=True, silent=True) or {}
    try:
        symbol = str(data.get("symbol") or "").strip()
        account = float(data.get("account") or 0)
        risk_pct = float(data.get("risk_pct") or 0)
        stop_method = (data.get("stop_method") or "atr").lower()
        custom_stop = data.get("custom_stop")
        custom_stop = float(custom_stop) if custom_stop not in (None, "") else None
        atr_mult = float(data.get("atr_multiplier") or 2.0)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid numeric input"}), 400
    result = _position_size(symbol, account, risk_pct, stop_method, custom_stop, atr_mult)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@app.route("/api/portfolios/<int:pid>/sell", methods=["POST"])
def sell_shares(pid: int):
    """Realize a sell against existing lots using FIFO or LIFO accounting.

    Body: {symbol, shares, sell_price, method: "FIFO"|"LIFO"}
    Records a transactions row and decrements/deletes holdings lots.
    """
    data = request.get_json(force=True, silent=True) or {}
    symbol = (data.get("symbol") or "").upper().strip()
    try:
        shares_to_sell = float(data.get("shares"))
        sell_price = float(data.get("sell_price"))
    except (TypeError, ValueError):
        return jsonify({"error": "shares and sell_price must be numbers"}), 400
    method = (data.get("method") or "FIFO").upper()
    if method not in ("FIFO", "LIFO"):
        return jsonify({"error": "method must be FIFO or LIFO"}), 400
    if shares_to_sell <= 0 or sell_price < 0 or not symbol:
        return jsonify({"error": "invalid input"}), 400

    db = get_db()
    order = "ASC" if method == "FIFO" else "DESC"
    lots = db.execute(
        f"SELECT id, shares, cost_basis, acquired_at, created_at "
        f"FROM holdings WHERE portfolio_id = ? AND symbol = ? "
        f"ORDER BY COALESCE(acquired_at, created_at) {order}",
        (pid, symbol),
    ).fetchall()
    total_held = sum(float(r["shares"]) for r in lots)
    if shares_to_sell - total_held > 1e-9:
        return jsonify({"error": f"only {total_held} shares of {symbol} held"}), 400

    remaining = shares_to_sell
    cost_total = 0.0
    lot_ids: list[int] = []
    for lot in lots:
        if remaining <= 1e-9:
            break
        lot_shares = float(lot["shares"])
        cost = float(lot["cost_basis"])
        take = min(lot_shares, remaining)
        cost_total += take * cost
        lot_ids.append(int(lot["id"]))
        new_shares = lot_shares - take
        if new_shares <= 1e-9:
            db.execute("DELETE FROM holdings WHERE id = ?", (lot["id"],))
        else:
            db.execute("UPDATE holdings SET shares = ? WHERE id = ?", (new_shares, lot["id"]))
        remaining -= take

    proceeds = shares_to_sell * sell_price
    realized = proceeds - cost_total
    weighted_cost = cost_total / shares_to_sell if shares_to_sell else 0.0
    cur = db.execute(
        "INSERT INTO transactions(portfolio_id, symbol, shares, sell_price, cost_basis, "
        "proceeds, realized_pl, method, lot_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, symbol, shares_to_sell, sell_price, weighted_cost,
         round(proceeds, 4), round(realized, 4), method, json.dumps(lot_ids)),
    )
    db.commit()
    return jsonify({
        "id": cur.lastrowid,
        "symbol": symbol,
        "shares": shares_to_sell,
        "sell_price": sell_price,
        "cost_basis": round(weighted_cost, 4),
        "proceeds": round(proceeds, 2),
        "realized_pl": round(realized, 2),
        "method": method,
        "lot_ids": lot_ids,
    })


@app.route("/api/portfolios/<int:pid>/correlation")
def correlation(pid: int):
    """Pearson correlation of daily returns over the last N bars between every
    pair of holdings. >0.85 = basically the same trade. <0 = hedge.

    Useful for diversification: if your top 5 are all >0.9 correlated you don't
    have 5 positions, you have 1 position with 5x the risk.
    """
    try:
        n = int(request.args.get("bars") or 30)
    except ValueError:
        n = 30
    n = max(7, min(n, 180))
    db = get_db()
    rows = db.execute(
        "SELECT DISTINCT symbol FROM holdings WHERE portfolio_id = ? ORDER BY symbol",
        (pid,),
    ).fetchall()
    symbols = [r["symbol"] for r in rows]
    if len(symbols) < 2:
        return jsonify({"symbols": symbols, "matrix": [], "bars": n,
                        "note": "need at least 2 holdings to compute correlation"})

    # Pull recent closes for each symbol
    series: dict[str, list[float]] = {}
    for sym in symbols:
        q = fetch_quote(sym)
        if not q or not q.history or len(q.history) < n + 1:
            continue
        last_n_plus_1 = q.history[-(n + 1):]
        series[sym] = [bar["close"] for bar in last_n_plus_1]

    valid = [s for s in symbols if s in series]
    # Daily returns
    returns: dict[str, list[float]] = {}
    for sym, closes in series.items():
        rets = []
        for i in range(1, len(closes)):
            prev = closes[i - 1]
            rets.append((closes[i] - prev) / prev if prev else 0.0)
        returns[sym] = rets

    def _corr(a: list[float], b: list[float]) -> float:
        n_pts = min(len(a), len(b))
        if n_pts < 3:
            return 0.0
        a, b = a[-n_pts:], b[-n_pts:]
        ma, mb = sum(a) / n_pts, sum(b) / n_pts
        num = sum((a[i] - ma) * (b[i] - mb) for i in range(n_pts))
        da  = math.sqrt(sum((a[i] - ma) ** 2 for i in range(n_pts)))
        db_ = math.sqrt(sum((b[i] - mb) ** 2 for i in range(n_pts)))
        return (num / (da * db_)) if (da and db_) else 0.0

    matrix: list[list[float]] = []
    for s1 in valid:
        row = []
        for s2 in valid:
            if s1 == s2:
                row.append(1.0)
            else:
                row.append(round(_corr(returns[s1], returns[s2]), 3))
        matrix.append(row)

    # Find the most-correlated pair (warn the user)
    worst_pair = None
    max_corr = -2.0
    for i in range(len(valid)):
        for j in range(i + 1, len(valid)):
            c = matrix[i][j]
            if c > max_corr:
                max_corr = c
                worst_pair = (valid[i], valid[j], c)

    return jsonify({
        "symbols": valid,
        "matrix": matrix,
        "bars": n,
        "highest_pair": {"a": worst_pair[0], "b": worst_pair[1],
                         "corr": worst_pair[2]} if worst_pair else None,
    })


@app.route("/api/portfolios/<int:pid>/transactions")
def list_transactions(pid: int):
    db = get_db()
    rows = db.execute(
        "SELECT id, symbol, shares, sell_price, cost_basis, proceeds, realized_pl, "
        "method, lot_ids, sold_at FROM transactions WHERE portfolio_id = ? "
        "ORDER BY sold_at DESC LIMIT 200",
        (pid,),
    ).fetchall()
    out = []
    total_realized = 0.0
    for r in rows:
        d = dict(r)
        try:
            d["lot_ids"] = json.loads(d["lot_ids"] or "[]")
        except Exception:
            d["lot_ids"] = []
        total_realized += float(d["realized_pl"] or 0)
        out.append(d)
    return jsonify({"transactions": out, "total_realized": round(total_realized, 2)})


@app.route("/api/portfolios/<int:pid>/import", methods=["POST"])
def import_csv(pid: int):
    """Import holdings from a CSV export (Fidelity/Schwab/Robinhood/Vanguard or generic).

    Body: {csv: "<raw csv text>"} or multipart file upload under 'file'.
    Columns are fuzzy-matched case-insensitive: symbol/ticker, shares/quantity/qty,
    cost/cost basis/average cost/price paid.
    """
    raw = ""
    if "file" in request.files:
        raw = request.files["file"].read().decode("utf-8", errors="ignore")
    else:
        data = request.get_json(force=True, silent=True) or {}
        raw = data.get("csv") or ""
    if not raw.strip():
        return jsonify({"error": "empty CSV"}), 400

    symbol_keys = ("symbol", "ticker", "security")
    share_keys = ("shares", "quantity", "qty", "amount")
    cost_keys = ("avg cost", "average cost", "cost basis", "cost per share",
                 "price paid", "avg price", "unit cost", "cost", "price")

    def _pick(row: dict, keys: tuple[str, ...]) -> str | None:
        lowered = {k.lower().strip(): v for k, v in row.items() if k}
        for key in keys:
            if key in lowered and str(lowered[key]).strip():
                return str(lowered[key]).strip()
        # fuzzy contains
        for key in keys:
            for k, v in lowered.items():
                if key in k and str(v).strip():
                    return str(v).strip()
        return None

    reader = csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames:
        return jsonify({"error": "CSV has no header row"}), 400

    db = get_db()
    added, errors = [], []
    for idx, row in enumerate(reader, start=2):
        sym = (_pick(row, symbol_keys) or "").upper().strip()
        sym = sym.split()[0] if sym else sym  # "AAPL - Apple Inc" -> "AAPL"
        sym = sym.replace("$", "")
        shares_raw = _pick(row, share_keys)
        cost_raw = _pick(row, cost_keys)
        if not sym or not shares_raw:
            errors.append({"row": idx, "error": "missing symbol or shares"})
            continue
        try:
            shares = float(str(shares_raw).replace(",", "").replace("$", ""))
        except ValueError:
            errors.append({"row": idx, "symbol": sym, "error": "bad shares value"})
            continue
        try:
            cost = float(str(cost_raw).replace(",", "").replace("$", "")) if cost_raw else 0.0
        except ValueError:
            cost = 0.0
        if shares <= 0:
            errors.append({"row": idx, "symbol": sym, "error": "shares must be positive"})
            continue
        q = fetch_quote(sym)
        if q is None:
            errors.append({"row": idx, "symbol": sym, "error": "symbol not found"})
            continue
        if cost <= 0:
            cost = q.price  # default to current price if no cost basis given
        cur = db.execute(
            "INSERT INTO holdings(portfolio_id, symbol, shares, cost_basis, note) "
            "VALUES (?, ?, ?, ?, ?)",
            (pid, sym, shares, cost, "imported"),
        )
        added.append({"id": cur.lastrowid, "symbol": sym, "shares": shares, "cost_basis": cost})
    db.commit()
    return jsonify({"added": added, "errors": errors})


def _backtest_symbol(symbol: str, years: float, starting_cash: float) -> dict:
    """Walk-forward EMA strategy: BUY full position near 21 EMA with bullish stack,
    SELL when extended >8% above 21 EMA. Compare to buy-and-hold."""
    q = fetch_quote(symbol, force=False)
    if q is None or not q.history:
        return {"error": f"{symbol} not found"}
    hist = q.history
    # Trim to requested window
    max_bars = max(1, min(len(hist), int(years * 252)))
    hist = hist[-max_bars:]

    cash = starting_cash
    shares = 0.0
    prev_signal = None
    trades: list[dict] = []
    equity_curve: list[dict] = []

    for i, bar in enumerate(hist):
        close = bar.get("close") or 0
        e9 = bar.get("ema9")
        e21 = bar.get("ema21")
        e50 = bar.get("ema50")
        e200 = bar.get("ema200")
        signal, _ = _overkill_signal(close, e9, e21, e50, e200)
        # Act on the OPEN of the next bar (use this bar's close as execution proxy)
        if signal == "BUY" and shares == 0 and cash > 0 and close > 0:
            shares = cash / close
            cost = cash
            cash = 0.0
            trades.append({"date": bar["date"], "action": "BUY",
                           "price": round(close, 4), "shares": round(shares, 4),
                           "cost": round(cost, 2)})
        elif signal == "SELL" and shares > 0 and close > 0:
            proceeds = shares * close
            trades.append({"date": bar["date"], "action": "SELL",
                           "price": round(close, 4), "shares": round(shares, 4),
                           "proceeds": round(proceeds, 2)})
            cash = proceeds
            shares = 0.0
        equity = cash + shares * (close or 0)
        equity_curve.append({"date": bar["date"], "equity": round(equity, 2),
                             "price": round(close, 4), "signal": signal})
        prev_signal = signal

    # Final mark-to-market
    final_close = hist[-1]["close"] or 0
    final_equity = cash + shares * final_close
    bh_shares = starting_cash / (hist[0]["close"] or 1)
    bh_equity = bh_shares * final_close
    strategy_return = (final_equity / starting_cash - 1) * 100
    bh_return = (bh_equity / starting_cash - 1) * 100

    # Win rate: of completed round-trips
    wins = losses = 0
    for i in range(1, len(trades)):
        if trades[i]["action"] == "SELL" and trades[i - 1]["action"] == "BUY":
            if trades[i]["price"] > trades[i - 1]["price"]:
                wins += 1
            else:
                losses += 1

    return {
        "symbol": symbol,
        "bars": len(hist),
        "from": hist[0]["date"],
        "to": hist[-1]["date"],
        "starting_cash": starting_cash,
        "final_equity": round(final_equity, 2),
        "buy_hold_equity": round(bh_equity, 2),
        "strategy_return_pct": round(strategy_return, 2),
        "buy_hold_return_pct": round(bh_return, 2),
        "outperformance_pct": round(strategy_return - bh_return, 2),
        "round_trips": wins + losses,
        "wins": wins,
        "losses": losses,
        "win_rate_pct": round(wins / (wins + losses) * 100, 1) if (wins + losses) else 0,
        "trades": trades,
        "equity_curve": equity_curve,
    }


@app.route("/api/backtest", methods=["POST"])
def backtest_route():
    data = request.get_json(force=True, silent=True) or {}
    symbol = (data.get("symbol") or "").upper().strip()
    try:
        years = float(data.get("years") or 1.0)
        cash = float(data.get("starting_cash") or 10000)
    except (TypeError, ValueError):
        return jsonify({"error": "invalid numeric input"}), 400
    if not symbol:
        return jsonify({"error": "symbol required"}), 400
    result = _backtest_symbol(symbol, years, cash)
    status = 400 if "error" in result else 200
    return jsonify(result), status


@app.route("/api/portfolios/<int:pid>/alerts", methods=["GET", "POST"])
def alert_prefs(pid: int):
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        email = (data.get("email") or "").strip() or None
        enabled = 1 if data.get("enabled") else 0
        daily = 1 if data.get("daily_digest") else 0
        try:
            hour = int(data.get("digest_hour_utc") if data.get("digest_hour_utc") is not None else 13)
        except (TypeError, ValueError):
            hour = 13
        hour = max(0, min(23, hour))
        webhook = (data.get("discord_webhook") or "").strip() or None
        if webhook and not webhook.startswith("https://discord.com/api/webhooks/") \
                and not webhook.startswith("https://discordapp.com/api/webhooks/"):
            return jsonify({"error": "discord_webhook must be a discord.com webhook URL"}), 400
        discord_enabled = 1 if data.get("discord_enabled") else 0
        db.execute(
            "INSERT INTO alert_prefs(portfolio_id, email, enabled, daily_digest, digest_hour_utc, "
            "discord_webhook, discord_enabled, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(portfolio_id) DO UPDATE SET email = excluded.email, "
            "enabled = excluded.enabled, daily_digest = excluded.daily_digest, "
            "digest_hour_utc = excluded.digest_hour_utc, "
            "discord_webhook = excluded.discord_webhook, "
            "discord_enabled = excluded.discord_enabled, "
            "updated_at = CURRENT_TIMESTAMP",
            (pid, email, enabled, daily, hour, webhook, discord_enabled),
        )
        db.commit()
    row = db.execute(
        "SELECT email, enabled, daily_digest, digest_hour_utc, last_digest_date, "
        "discord_webhook, discord_enabled, updated_at "
        "FROM alert_prefs WHERE portfolio_id = ?",
        (pid,),
    ).fetchone()
    return jsonify({
        "email":            row["email"] if row else None,
        "enabled":          bool(row["enabled"]) if row else False,
        "daily_digest":     bool(row["daily_digest"]) if row else False,
        "digest_hour_utc":  int(row["digest_hour_utc"]) if row else 13,
        "last_digest_date": row["last_digest_date"] if row else None,
        "discord_webhook":  row["discord_webhook"] if row else None,
        "discord_enabled":  bool(row["discord_enabled"]) if row else False,
        "updated_at":       row["updated_at"] if row else None,
        "smtp_configured":  bool(SMTP_HOST and SMTP_USER and SMTP_PASS),
    })


# ---------------------------------------------------------------------------
# Custom thesis endpoints
# ---------------------------------------------------------------------------

@app.route("/api/portfolios/<int:pid>/theses", methods=["GET", "POST"])
def theses_route(pid: int):
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        sym = (data.get("symbol") or "").strip().upper()
        if not sym:
            return jsonify({"error": "symbol is required"}), 400
        name = (data.get("name") or "").strip() or f"{sym} thesis"
        buy_rules  = data.get("buy_rules")  or []
        sell_rules = data.get("sell_rules") or []
        err = _validate_thesis_rules(buy_rules) or _validate_thesis_rules(sell_rules)
        if err:
            return jsonify({"error": err}), 400
        if not buy_rules and not sell_rules:
            return jsonify({"error": "add at least one buy or sell rule"}), 400
        notes = (data.get("notes") or "").strip()
        enabled = 1 if data.get("enabled", 1) else 0
        db.execute(
            "INSERT INTO coin_theses(portfolio_id, symbol, name, buy_rules, sell_rules, "
            "notes, enabled, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            (pid, sym, name, json.dumps(buy_rules), json.dumps(sell_rules),
             notes, enabled),
        )
        db.commit()
    return jsonify({"theses": _load_theses(db, pid)})


@app.route("/api/portfolios/<int:pid>/theses/<int:tid>",
           methods=["PATCH", "DELETE"])
def thesis_detail(pid: int, tid: int):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM coin_theses WHERE id = ? AND portfolio_id = ?",
                   (tid, pid))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json(force=True, silent=True) or {}
    fields, values = [], []
    if "name" in data:
        fields.append("name = ?")
        values.append((data.get("name") or "").strip() or "thesis")
    if "buy_rules" in data:
        rules = data.get("buy_rules") or []
        err = _validate_thesis_rules(rules)
        if err: return jsonify({"error": err}), 400
        fields.append("buy_rules = ?")
        values.append(json.dumps(rules))
    if "sell_rules" in data:
        rules = data.get("sell_rules") or []
        err = _validate_thesis_rules(rules)
        if err: return jsonify({"error": err}), 400
        fields.append("sell_rules = ?")
        values.append(json.dumps(rules))
    if "notes" in data:
        fields.append("notes = ?")
        values.append((data.get("notes") or "").strip())
    if "enabled" in data:
        fields.append("enabled = ?")
        values.append(1 if data.get("enabled") else 0)
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    fields.append("updated_at = CURRENT_TIMESTAMP")
    values.extend([tid, pid])
    db.execute(f"UPDATE coin_theses SET {', '.join(fields)} "
               "WHERE id = ? AND portfolio_id = ?", values)
    db.commit()
    return jsonify({"theses": _load_theses(db, pid)})


# ---------------------------------------------------------------------------
# Server-side watchlist endpoints
# ---------------------------------------------------------------------------

@app.route("/api/portfolios/<int:pid>/watchlist", methods=["GET", "POST"])
def watchlist_route(pid: int):
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        sym = (data.get("symbol") or "").strip().upper()
        if not sym:
            return jsonify({"error": "symbol is required"}), 400
        # Validate the ticker actually has data — same as add-holding flow
        q = fetch_quote(sym)
        if q is None:
            return jsonify({"error": f"no market data found for {sym}"}), 400
        db.execute(
            "INSERT OR IGNORE INTO watchlist(portfolio_id, symbol, added_at) "
            "VALUES (?, ?, CURRENT_TIMESTAMP)",
            (pid, sym),
        )
        db.commit()
    rows = db.execute(
        "SELECT symbol, added_at FROM watchlist WHERE portfolio_id = ? ORDER BY symbol",
        (pid,),
    ).fetchall()
    return jsonify({"watchlist": [{"symbol": r["symbol"], "added_at": r["added_at"]}
                                  for r in rows]})


@app.route("/api/portfolios/<int:pid>/watchlist/<symbol>", methods=["DELETE"])
def watchlist_delete(pid: int, symbol: str):
    db = get_db()
    db.execute("DELETE FROM watchlist WHERE portfolio_id = ? AND symbol = ?",
               (pid, symbol.upper()))
    # Also nuke any alert rules for that symbol — they'd be orphans otherwise
    db.execute("DELETE FROM alert_rules WHERE portfolio_id = ? AND symbol = ?",
               (pid, symbol.upper()))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Alert rule endpoints — price/movement/volume alerts for any symbol
# ---------------------------------------------------------------------------

_ALERT_KINDS = {"price_above", "price_below", "pct_move_24h",
                "volume_spike", "signal_flip"}


def _validate_alert_rule(kind: str, params: dict) -> str | None:
    if kind not in _ALERT_KINDS:
        return f"unknown alert kind '{kind}'"
    if not isinstance(params, dict):
        return "params must be an object"
    if kind in ("price_above", "price_below"):
        try:
            float(params.get("value"))
        except (TypeError, ValueError):
            return "params.value must be a number"
    elif kind == "pct_move_24h":
        try:
            float(params.get("pct"))
        except (TypeError, ValueError):
            return "params.pct must be a number (e.g. -15 for -15%)"
    elif kind == "volume_spike":
        try:
            float(params.get("threshold"))
        except (TypeError, ValueError):
            return "params.threshold must be a number (e.g. 3 for 3× avg vol)"
    # signal_flip needs no params
    return None


def _load_alert_rules(db, pid: int) -> list[dict]:
    rows = db.execute(
        "SELECT id, symbol, kind, params, enabled, last_fired_at, created_at "
        "FROM alert_rules WHERE portfolio_id = ? ORDER BY symbol, id",
        (pid,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try: d["params"] = json.loads(d["params"] or "{}")
        except json.JSONDecodeError: d["params"] = {}
        d["enabled"] = bool(d["enabled"])
        out.append(d)
    return out


@app.route("/api/portfolios/<int:pid>/alert-rules", methods=["GET", "POST"])
def alert_rules_route(pid: int):
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        sym = (data.get("symbol") or "").strip().upper()
        kind = (data.get("kind") or "").strip()
        params = data.get("params") or {}
        if not sym:
            return jsonify({"error": "symbol is required"}), 400
        err = _validate_alert_rule(kind, params)
        if err:
            return jsonify({"error": err}), 400
        enabled = 1 if data.get("enabled", 1) else 0
        db.execute(
            "INSERT INTO alert_rules(portfolio_id, symbol, kind, params, enabled, "
            "created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
            (pid, sym, kind, json.dumps(params), enabled),
        )
        db.commit()
    return jsonify({"rules": _load_alert_rules(db, pid)})


@app.route("/api/portfolios/<int:pid>/alert-rules/<int:rid>",
           methods=["PATCH", "DELETE"])
def alert_rule_detail(pid: int, rid: int):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM alert_rules WHERE id = ? AND portfolio_id = ?",
                   (rid, pid))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json(force=True, silent=True) or {}
    fields, values = [], []
    if "enabled" in data:
        fields.append("enabled = ?")
        values.append(1 if data.get("enabled") else 0)
    if "params" in data:
        # Need the rule's kind to validate
        row = db.execute("SELECT kind FROM alert_rules WHERE id = ? AND portfolio_id = ?",
                         (rid, pid)).fetchone()
        if not row:
            return jsonify({"error": "rule not found"}), 404
        err = _validate_alert_rule(row["kind"], data.get("params") or {})
        if err: return jsonify({"error": err}), 400
        fields.append("params = ?")
        values.append(json.dumps(data.get("params") or {}))
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    values.extend([rid, pid])
    db.execute(f"UPDATE alert_rules SET {', '.join(fields)} "
               "WHERE id = ? AND portfolio_id = ?", values)
    db.commit()
    return jsonify({"rules": _load_alert_rules(db, pid)})


# ---------------------------------------------------------------------------
# Jarvis memory endpoints — what the AI agent remembers about the user
# ---------------------------------------------------------------------------

_JARVIS_KINDS = {"preference", "fact", "summary"}


@app.route("/api/portfolios/<int:pid>/jarvis/memory", methods=["GET", "POST"])
def jarvis_memory(pid: int):
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        kind = (data.get("kind") or "fact").strip()
        value = (data.get("value") or "").strip()
        key = (data.get("key") or "").strip() or None
        if kind not in _JARVIS_KINDS:
            return jsonify({"error": f"kind must be one of {sorted(_JARVIS_KINDS)}"}), 400
        if not value:
            return jsonify({"error": "value is required"}), 400
        # Cap value length so the prompt stays small
        if len(value) > 400:
            return jsonify({"error": "memory entry too long (max 400 chars)"}), 400
        db.execute(
            "INSERT INTO jarvis_memory(portfolio_id, kind, key, value, created_at) "
            "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
            (pid, kind, key, value),
        )
        db.commit()
    rows = db.execute(
        "SELECT id, kind, key, value, created_at FROM jarvis_memory "
        "WHERE portfolio_id = ? ORDER BY created_at DESC LIMIT 200",
        (pid,),
    ).fetchall()
    return jsonify({"memory": [dict(r) for r in rows]})


@app.route("/api/portfolios/<int:pid>/jarvis/memory/<int:mid>", methods=["DELETE"])
def jarvis_memory_delete(pid: int, mid: int):
    db = get_db()
    db.execute("DELETE FROM jarvis_memory WHERE id = ? AND portfolio_id = ?",
               (mid, pid))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/portfolios/<int:pid>/discord/test", methods=["POST"])
def discord_test(pid: int):
    """Fire a test message to the saved Discord webhook so the user knows it works."""
    db = get_db()
    row = db.execute(
        "SELECT discord_webhook FROM alert_prefs WHERE portfolio_id = ?", (pid,),
    ).fetchone()
    if not row or not row["discord_webhook"]:
        return jsonify({"error": "no Discord webhook saved for this portfolio"}), 400
    _send_discord_alert(row["discord_webhook"], "TEST", "—", "BUY",
                        0.0, "ChurnLence test ping — alerts are working.")
    return jsonify({"ok": True})


def _build_digest(pid: int) -> dict:
    """Compose the data for a daily summary: BUY / SELL / HOLD by symbol."""
    snap = _portfolio_snapshot(pid)
    rows = snap.get("rows") or []
    buys, sells, holds = [], [], []
    for r in rows:
        if r.get("error"):
            continue
        bucket = {
            "symbol": r["symbol"], "price": r.get("price"),
            "change_pct": r.get("change_pct"),
            "signal": r.get("signal"), "reason": r.get("signal_reason"),
            "stop_atr": r.get("stop_atr"), "stop_ma": r.get("stop_loss"),
        }
        if r.get("signal") == "BUY":   buys.append(bucket)
        elif r.get("signal") == "SELL": sells.append(bucket)
        else:                           holds.append(bucket)
    return {
        "portfolio": snap.get("portfolio"),
        "totals":    snap.get("totals"),
        "buys": buys, "sells": sells, "holds": holds,
        "concentration": snap.get("concentration"),
        "as_of":     snap.get("updated_at"),
    }


def _format_digest_text(pid: int, name: str, dig: dict) -> tuple[str, str]:
    """Returns (subject, plain-text body) for the daily email."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    n_buy = len(dig["buys"]); n_sell = len(dig["sells"]); n_hold = len(dig["holds"])
    subject = f"ChurnLence · {name} · {today} · {n_buy} BUY · {n_sell} SELL · {n_hold} HOLD"

    def _line(b):
        chg = (b.get("change_pct") or 0)
        arrow = "▲" if chg >= 0 else "▼"
        stop = b.get("stop_atr") or b.get("stop_ma")
        stop_s = f"  stop {stop:.4f}" if stop else ""
        return f"  {b['symbol']:<10} {b.get('price', 0):>10.4f}  {arrow} {chg:+.2f}%{stop_s}\n     ↳ {b.get('reason') or ''}"

    lines = [f"Daily signals for portfolio: {name}", f"As of: {today} (UTC)", ""]
    t = dig.get("totals") or {}
    if t:
        lines.append(f"Portfolio value: ${t.get('value', 0):,.2f}  "
                     f"·  Day P/L ${t.get('day_pl', 0):,.2f}  "
                     f"·  Total P/L ${t.get('pl', 0):,.2f} ({t.get('pl_pct', 0):.2f}%)")
        lines.append("")
    if dig["buys"]:
        lines.append(f"== BUY ({n_buy}) — bullish stack near 21 EMA ==")
        lines.extend(_line(b) for b in dig["buys"])
        lines.append("")
    if dig["sells"]:
        lines.append(f"== SELL ({n_sell}) — extended above MA / bearish stack ==")
        lines.extend(_line(b) for b in dig["sells"])
        lines.append("")
    if dig["holds"]:
        lines.append(f"== HOLD ({n_hold}) ==")
        lines.extend(f"  {b['symbol']:<10} {b.get('price', 0):>10.4f}  ({b.get('reason') or ''})"
                     for b in dig["holds"])
    lines.append("")
    lines.append("Stop levels above are MA-3% or 2×ATR — the same numbers shown in the app.")
    lines.append("This is arithmetic, not advice.")
    return subject, "\n".join(lines)


@app.route("/api/portfolios/<int:pid>/digest/preview")
def digest_preview(pid: int):
    """Returns the JSON used to build today's email + the formatted text body."""
    dig = _build_digest(pid)
    name = dig.get("portfolio", {}).get("name", "Portfolio")
    subject, body = _format_digest_text(pid, name, dig)
    return jsonify({**dig, "subject": subject, "body": body})


@app.route("/api/portfolios/<int:pid>/digest/send", methods=["POST"])
def digest_send_now(pid: int):
    """Send today's digest immediately. Useful for testing SMTP."""
    db = get_db()
    row = db.execute(
        "SELECT email FROM alert_prefs WHERE portfolio_id = ?", (pid,),
    ).fetchone()
    if not row or not row["email"]:
        return jsonify({"error": "no email saved for this portfolio"}), 400
    if not (SMTP_HOST and SMTP_USER and SMTP_PASS):
        return jsonify({"error": "SMTP not configured on the server"}), 400
    dig = _build_digest(pid)
    name = dig.get("portfolio", {}).get("name", "Portfolio")
    subject, body = _format_digest_text(pid, name, dig)
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM or SMTP_USER
    msg["To"] = row["email"]
    msg.set_content(body)
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
    except Exception as exc:
        return jsonify({"error": f"SMTP send failed: {exc}"}), 500
    db.execute("UPDATE alert_prefs SET last_digest_date = ? WHERE portfolio_id = ?",
               (datetime.now(timezone.utc).strftime("%Y-%m-%d"), pid))
    db.commit()
    return jsonify({"ok": True, "to": row["email"], "subject": subject})


# ---------------------------------------------------------------------------
# Market regime — Fear & Greed + BTC dominance (both free, no key)
# ---------------------------------------------------------------------------

_market_cache: dict[str, tuple[float, dict]] = {}
_MARKET_TTL = 300  # 5 min

_funding_cache: dict[str, tuple[float, dict]] = {}
_FUNDING_TTL = 60  # 1 min — funding rates update on 1h/8h cadences but freshness matters


def _binance_funding(symbol: str) -> dict | None:
    """Fetch Binance USDT-perp funding + OI for a symbol like BTCUSDT."""
    try:
        prem_url = f"https://fapi.binance.com/fapi/v1/premiumIndex?symbol={symbol}"
        oi_url   = f"https://fapi.binance.com/fapi/v1/openInterest?symbol={symbol}"
        with urllib.request.urlopen(urllib.request.Request(prem_url, headers={"User-Agent": "ChurnLence/1.0"}), timeout=4) as r:
            prem = json.loads(r.read())
        with urllib.request.urlopen(urllib.request.Request(oi_url, headers={"User-Agent": "ChurnLence/1.0"}), timeout=4) as r:
            oi = json.loads(r.read())
        return {
            "venue":      "Binance",
            "symbol":     symbol,
            "mark_price": float(prem.get("markPrice", 0)),
            "funding":    float(prem.get("lastFundingRate", 0)) * 100,   # %
            "next_funding_at": prem.get("nextFundingTime"),
            "open_interest":   float(oi.get("openInterest", 0)),
        }
    except Exception:
        return None


def _bybit_funding(symbol: str) -> dict | None:
    """Bybit v5 perp tickers — single call returns mark + funding + OI."""
    try:
        url = f"https://api.bybit.com/v5/market/tickers?category=linear&symbol={symbol}"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"}), timeout=4) as r:
            payload = json.loads(r.read())
        items = (payload.get("result") or {}).get("list") or []
        if not items:
            return None
        t = items[0]
        return {
            "venue":      "Bybit",
            "symbol":     symbol,
            "mark_price": float(t.get("markPrice", 0)),
            "funding":    float(t.get("fundingRate", 0)) * 100,
            "next_funding_at": int(t.get("nextFundingTime", 0)) if t.get("nextFundingTime") else None,
            "open_interest":   float(t.get("openInterestValue", 0)),  # USD-quoted on Bybit
        }
    except Exception:
        return None


def _hyperliquid_funding() -> dict[str, dict]:
    """Hyperliquid: single bulk request returns funding + OI for ALL perps.
    Returns a dict keyed by symbol (e.g. 'BTC', 'SOL', 'HYPE')."""
    try:
        url = "https://api.hyperliquid.xyz/info"
        body = json.dumps({"type": "metaAndAssetCtxs"}).encode()
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "ChurnLence/1.0"})
        with urllib.request.urlopen(req, timeout=6) as r:
            payload = json.loads(r.read())
        meta, ctxs = payload[0], payload[1]
        universe = meta.get("universe") or []
        out: dict[str, dict] = {}
        for u, c in zip(universe, ctxs):
            sym = u.get("name", "")
            try:
                out[sym] = {
                    "venue":      "Hyperliquid",
                    "symbol":     sym,
                    "mark_price": float(c.get("markPx", 0)),
                    "funding":    float(c.get("funding", 0)) * 100,           # already hourly rate
                    "open_interest":   float(c.get("openInterest", 0)),
                    "day_volume":      float(c.get("dayNtlVlm", 0)),
                    "premium":         float(c.get("premium", 0)) * 100,
                }
            except (TypeError, ValueError):
                continue
        return out
    except Exception:
        return {}


@app.route("/api/funding")
def funding():
    """Aggregated derivatives data across Binance, Bybit, and Hyperliquid.

    Wave 6 + Wave 23 both flagged this as the most undersupplied UX in the
    retail crypto space.  Every input is a free public API.

    Query: ?symbol=BTC|SOL|XRP|...  (multiple via comma)
    Returns rate%, OI, mark price per venue + a venue-spread number when 2+
    venues report the same symbol (this is the cross-venue arb signal).
    """
    raw = (request.args.get("symbol") or "BTC,ETH,SOL").upper()
    syms = [s.strip() for s in raw.split(",") if s.strip()][:8]
    now = time.time()
    cache_key = "|".join(syms)
    cached = _funding_cache.get(cache_key)
    if cached and now - cached[0] < _FUNDING_TTL:
        return jsonify(cached[1])

    # Hyperliquid: one call for everything
    hl_all = _hyperliquid_funding()

    out_rows = []
    for sym in syms:
        venues = []
        # Binance perp = SYMBOL + USDT
        b = _binance_funding(sym + "USDT")
        if b: venues.append(b)
        # Bybit perp = SYMBOL + USDT
        y = _bybit_funding(sym + "USDT")
        if y: venues.append(y)
        # Hyperliquid uses bare symbol
        if sym in hl_all:
            venues.append(hl_all[sym])
        if not venues:
            continue
        # Cross-venue funding spread (max - min) — arb signal
        rates = [v["funding"] for v in venues if v.get("funding") is not None]
        spread_bps = (max(rates) - min(rates)) * 100 if len(rates) >= 2 else None
        # Aggregate OI weighted by USD value
        total_oi_usd = 0.0
        for v in venues:
            oi = v.get("open_interest") or 0
            mark = v.get("mark_price") or 0
            # Binance returns OI in coins; Bybit returns OI value (USD); HL too
            usd = oi if v["venue"] in ("Bybit", "Hyperliquid") else oi * mark
            v["open_interest_usd"] = round(usd, 0)
            total_oi_usd += usd
        out_rows.append({
            "symbol":      sym,
            "venues":      venues,
            "venues_count": len(venues),
            "spread_bps":  round(spread_bps, 2) if spread_bps is not None else None,
            "total_oi_usd": round(total_oi_usd, 0),
            "regime":      _funding_regime(rates),
        })

    body = {
        "rows":     out_rows,
        "as_of":    datetime.now(timezone.utc).isoformat(),
        "venues":   ["Binance", "Bybit", "Hyperliquid"],
    }
    _funding_cache[cache_key] = (now, body)
    return jsonify(body)


def _funding_regime(rates: list[float]) -> str:
    """Classify the funding regime from the average of a venue list.

    Numbers are in PERCENT per funding interval (Binance/Bybit settle every 8h,
    HL every hour — we treat them as comparable here for a rough regime read).
    """
    if not rates:
        return "no-data"
    avg = sum(rates) / len(rates)
    if avg > 0.075:
        return "overheated-long"     # >75 bps per 8h, classic mean-reversion zone
    if avg > 0.02:
        return "bullish-skew"
    if avg < -0.05:
        return "crowded-short"        # negative funding = shorts paying = squeeze setup
    if avg < -0.01:
        return "bearish-skew"
    return "neutral"


@app.route("/api/market")
def market():
    """Returns market-wide gauges traders watch:
    - Fear & Greed Index 0-100 (alternative.me)
    - BTC dominance, ETH/BTC ratio, total mcap, 24h vol (CoinGecko global)

    Cached 5 min server-side.  All free APIs, no key.
    """
    now = time.time()
    cached = _market_cache.get("snapshot")
    if cached and now - cached[0] < _MARKET_TTL:
        return jsonify(cached[1])

    out: dict = {"fetched_at": datetime.now(timezone.utc).isoformat()}

    # Fear & Greed (alternative.me)
    try:
        url = "https://api.alternative.me/fng/?limit=2"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"}), timeout=6) as r:
            payload = json.loads(r.read())
        data = (payload.get("data") or [])
        if data:
            today = data[0]
            yesterday = data[1] if len(data) > 1 else None
            out["fear_greed"] = {
                "value": int(today.get("value", 50)),
                "label": today.get("value_classification", "Neutral"),
                "yesterday": int(yesterday["value"]) if yesterday else None,
                "delta": (int(today["value"]) - int(yesterday["value"])) if yesterday else 0,
            }
    except Exception as exc:
        app.logger.warning("F&G fetch failed: %s", exc)
        out["fear_greed"] = None

    # CoinGecko /global
    try:
        url = "https://api.coingecko.com/api/v3/global"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"}), timeout=6) as r:
            payload = json.loads(r.read())
        d = payload.get("data") or {}
        mcap = d.get("market_cap_percentage") or {}
        total_mcap = (d.get("total_market_cap") or {}).get("usd")
        total_vol  = (d.get("total_volume")     or {}).get("usd")
        mcap_change = d.get("market_cap_change_percentage_24h_usd")
        out["global"] = {
            "btc_dominance":  round(mcap.get("btc", 0), 2),
            "eth_dominance":  round(mcap.get("eth", 0), 2),
            "total_mcap_usd": total_mcap,
            "total_vol_usd":  total_vol,
            "mcap_change_24h_pct": round(mcap_change, 2) if mcap_change is not None else None,
            "active_cryptocurrencies": d.get("active_cryptocurrencies"),
        }
    except Exception as exc:
        app.logger.warning("CoinGecko global fetch failed: %s", exc)
        out["global"] = None

    # Quick read for the UI banner
    if out.get("fear_greed") and out.get("global"):
        fg = out["fear_greed"]["value"]
        btc_dom = out["global"]["btc_dominance"]
        if fg < 25 and btc_dom > 55:
            regime = "Risk off — capitulation"
        elif fg < 25:
            regime = "Fearful — possible bottom"
        elif fg > 75 and btc_dom < 50:
            regime = "Alt-season risk-on"
        elif fg > 75:
            regime = "Greedy — take profits"
        elif btc_dom > 58:
            regime = "BTC-dominant — alts struggle"
        elif btc_dom < 48:
            regime = "Alt momentum"
        else:
            regime = "Neutral"
        out["regime"] = regime

    _market_cache["snapshot"] = (now, out)
    return jsonify(out)


# ---------------------------------------------------------------------------
# News headlines per coin — CryptoPanic free tier (no key required)
# ---------------------------------------------------------------------------

_news_cache: dict[str, tuple[float, list]] = {}
_NEWS_TTL = 600  # 10 min


@app.route("/api/news/<symbol>")
def news(symbol: str):
    """Top news for a coin.  Uses CryptoPanic's no-auth public endpoint
    so we don't need a key.  Falls back gracefully when the API is down."""
    sym = symbol.upper().replace("-USD", "").strip()
    if not sym:
        return jsonify([])
    now = time.time()
    cached = _news_cache.get(sym)
    if cached and now - cached[0] < _NEWS_TTL:
        return jsonify(cached[1])
    try:
        url = f"https://cryptopanic.com/api/free/v1/posts/?currencies={sym.lower()}&public=true"
        req = urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"})
        with urllib.request.urlopen(req, timeout=6) as r:
            payload = json.loads(r.read())
        items = []
        for post in (payload.get("results") or [])[:10]:
            items.append({
                "title":     post.get("title") or "",
                "url":       post.get("url") or "",
                "source":    (post.get("source") or {}).get("title") or "",
                "domain":    (post.get("source") or {}).get("domain") or "",
                "published": post.get("published_at") or "",
                "votes":     (post.get("votes") or {}),
                "kind":      post.get("kind") or "news",
            })
        _news_cache[sym] = (now, items)
        return jsonify(items)
    except Exception as exc:
        app.logger.warning("news fetch failed for %s: %s", sym, exc)
        return jsonify(cached[1] if cached else [])


# ---------------------------------------------------------------------------
# AI copilot — Claude Haiku (Anthropic) integration
# Wave 7 said LLM-as-research-copilot is the only AI bucket worth shipping.
# This is that.  User brings their own Anthropic API key (sk-ant-...).
# Falls back to a helpful canned response when no key is configured (so the
# UI works in demo mode and users can see what they're paying for first).
# ---------------------------------------------------------------------------

_AI_CONFIG_FILE = os.path.join(os.path.dirname(_default_db_path()), "ai-config.json")
_AI_MODEL = "claude-haiku-4-5"  # cheap, fast, smart enough for trading-copilot work
_AI_MAX_TOKENS = 700            # keep responses tight per Wave 7 rules


def _ai_load_config() -> dict:
    try:
        with open(_AI_CONFIG_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _ai_save_config(cfg: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_AI_CONFIG_FILE), exist_ok=True)
        with open(_AI_CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except OSError as exc:
        app.logger.warning("ai config save failed: %s", exc)


_JARVIS_TOOLS_BLOCK = """
TOOLS YOU CAN PROPOSE (Jarvis agent mode):
You may emit at most three tool-call blocks per reply, on their own lines, using
this EXACT syntax — the client parses them and runs the action:

  [[ACTION:name|<json args>]]

Available actions:
  add_to_watchlist     {"symbol":"SOL-USD"}
  remove_from_watchlist{"symbol":"SOL-USD"}
  open_chart           {"symbol":"BTC-USD"}
  set_tab              {"tab":"holdings"}              tabs: overview|holdings|charts|signals|watchlist|planner|backtest|scanner
  set_mode             {"mode":"day"}                  modes: swing|day
  create_alert_rule    {"symbol":"DOGE-USD","kind":"price_above","params":{"value":0.50}}
  refresh              {}
  summarize_holdings   {}
  confirm              {"action":"sell","args":{...},"why":"…"}   propose a destructive action; user must click Run

RULES:
- Destructive intents (sell, delete) MUST use `confirm` first.  Never emit a
  raw `sell` / `delete_*` action.
- After the action block, briefly explain in plain English what you did and why.
- Skip the action block if the user is just chatting or asking a question — only
  emit tool calls when they explicitly ask for something to happen.
"""


def _ai_system_prompt(snapshot: dict | None, chart_symbol: str | None,
                      mode: str = "swing", memory: list[dict] | None = None) -> str:
    """Build the system prompt with current portfolio context inlined."""
    parts = [
        "You are ChurnLence's trading copilot. You help a swing/memecoin crypto",
        "trader understand their portfolio, signals, and indicators.",
        "",
        "HARD RULES — never violate these:",
        "- Never predict prices.  Don't say 'X will go to $Y'.",
        "- Never tell the user what to trade.  They make the decisions.",
        "- Never make up numbers.  If you don't have data, say so.",
        "- Keep responses SHORT — 3-5 sentences max unless explicitly asked for more.",
        "- Use plain English.  Define jargon (e.g., 'MACD = momentum indicator').",
        "- When citing a number, name the source ('Per the Overkill EMA signal: ...').",
        "",
        "WHAT YOU SHOULD DO:",
        "- Explain WHY a signal fired ('EMA 9 crossed above EMA 21 + RVOL 2.3x = momentum confirmation')",
        "- Summarise a coin from the live data ('SOL is up 3% today, RSI 56 (neutral), MACD positive')",
        "- Explain indicators ('MACD histogram above zero = bullish momentum')",
        "- Draft a trade-journal entry from numbers",
        "- Help the user navigate ChurnLence (tabs, hotkeys, features)",
        "",
        "WHAT YOU SHOULD REFUSE:",
        "- 'Should I buy ZBCN?' → 'I can't tell you what to trade.  Here's what the data shows...'",
        "- 'What will BTC do tomorrow?' → 'I can't predict prices.  Here's the current setup...'",
        "- 'Pick me a coin to buy' → 'I can summarise what's currently flagged BUY in your watchlist...'",
        "",
        "TRADING MODE: " + mode.upper() +
        (" (始解 Shikai = swing, daily candles, 9/21/50/200 EMAs, slow/high-conviction)"
         if mode == "swing" else
         " (卍解 Bankai = day trade, 15-min candles, 9/21/50 EMAs, tighter stops)"),
        "",
    ]
    if snapshot and snapshot.get("rows"):
        parts.append("CURRENT PORTFOLIO (live, refreshed on every message):")
        t = snapshot.get("totals") or {}
        parts.append(f"  Total value: ${t.get('value', 0):,.2f}  ·  "
                     f"Day P/L: ${t.get('day_pl', 0):,.2f}  ·  "
                     f"Total P/L: ${t.get('pl', 0):,.2f} ({t.get('pl_pct', 0):.2f}%)")
        parts.append("  Holdings:")
        for r in snapshot["rows"]:
            if r.get("error"):
                continue
            line = (
                f"    {r['symbol']:<10} {r.get('shares', 0):>10.4f} sh  "
                f"@ ${r.get('price', 0):>10.4f}  "
                f"P/L ${r.get('pl', 0):>+9,.2f} ({r.get('pl_pct', 0):>+6.2f}%)  "
                f"signal={r.get('signal', 'HOLD')}"
            )
            extras = []
            if r.get("rsi") is not None:
                extras.append(f"RSI {r['rsi']:.0f}")
            if r.get("macd_hist") is not None:
                extras.append(f"MACD {'+' if r['macd_hist'] >= 0 else ''}{r['macd_hist']:.2f}")
            if r.get("rvol") is not None:
                extras.append(f"VOL {r['rvol']:.1f}x")
            if r.get("stop_atr") is not None:
                extras.append(f"stop ${r['stop_atr']:.4f}")
            if extras:
                line += "  [" + " · ".join(extras) + "]"
            parts.append(line)
        parts.append("")
        c = snapshot.get("concentration") or {}
        if c.get("hhi"):
            parts.append(f"  Concentration HHI: {c['hhi']} ({c.get('grade', '—')})")
            parts.append("")
    if chart_symbol:
        parts.append(f"CURRENTLY VIEWED CHART: {chart_symbol}")
        parts.append("")
    parts.append("ChurnLence has these tabs (Cmd-K to jump): Overview, Holdings, "
                 "Charts, Signals, Watchlist, Planner, Backtest, Scanner.")
    parts.append("Indicators on every quote: EMA 9/21/50/200, RSI(14), ATR(14), "
                 "RVOL (volume vs 20-bar avg), MACD(12,26,9), Bollinger Bands(20,2σ).")
    if memory:
        parts.append("")
        parts.append("WHAT YOU REMEMBER ABOUT THIS USER:")
        for m in memory[:20]:
            kind = m.get("kind", "fact")
            val = (m.get("value") or "").strip()
            if val:
                parts.append(f"  [{kind}] {val}")
    parts.append(_JARVIS_TOOLS_BLOCK)
    return "\n".join(parts)


def _ai_demo_reply(message: str, snapshot: dict | None) -> str:
    """Plausible canned response when no API key is set — so the chat UI can
    be exercised in demo mode without spending money."""
    msg = message.lower()
    if "why" in msg and "buy" in msg:
        return ("**(Demo response — set your Anthropic key to get real Claude.)** "
                "When a coin gets a BUY signal in ChurnLence, it usually means: "
                "(a) the bullish EMA stack (9 > 21 > 50 > 200) is intact, AND "
                "(b) price is within 1.5% of the 21 EMA, AND (c) RVOL > 1.5× "
                "(real volume, not chop). The 'reason' field on the signal chip "
                "tells you which condition triggered.")
    if "why" in msg and "sell" in msg:
        return ("**(Demo response — set your Anthropic key for real Claude.)** "
                "SELL fires either when the EMA stack flips bearish OR when price "
                "extends >8% above the 21 EMA in swing mode (>5% in BANKAI mode) — "
                "the 'take profit' case. Hover the SELL chip to see the exact reason.")
    if "macd" in msg:
        return ("**(Demo)** MACD = momentum. The histogram (line minus signal) "
                "tells you the direction: positive and rising = bullish momentum "
                "accelerating; positive but falling = momentum cooling. The chip "
                "on the chart tab shows the current value.")
    if "rsi" in msg:
        return ("**(Demo)** RSI(14) is a momentum oscillator: > 70 = overbought "
                "(price has risen too fast), < 30 = oversold. The chip is red on "
                "overbought, green on oversold, dim on neutral.")
    if "kelly" in msg:
        return ("**(Demo)** Kelly = math-optimal position size given your win-rate "
                "and payoff ratio. Open the Planner tab; ChurnLence reads your "
                "closed sells from the transactions table and shows full-Kelly + "
                "half-Kelly bet size in dollars.")
    if "bankai" in msg or "shikai" in msg or "mode" in msg:
        return ("**(Demo)** SHIKAI 始解 = swing mode (daily candles, 9/21/50/200 "
                "EMAs, ATR×2 stops, ~8% take-profit). BANKAI 卍解 = day-trade mode "
                "(15-min candles, faster signals, tighter ATR×1 stops, ~5% take-"
                "profit). Toggle in the topbar.")
    return ("**(Demo response — set your Anthropic API key in Settings to get "
            "real Claude responses.)** I can explain why a signal fired, summarise "
            "a coin, walk through any indicator (RSI / MACD / Bollinger / ATR), "
            "draft a trade-journal entry, or help you navigate ChurnLence. Try "
            "asking 'why is SOL on BUY?' or 'explain MACD'.")


@app.route("/api/ai/config", methods=["GET", "POST"])
def ai_config():
    cfg = _ai_load_config()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        if "api_key" in data:
            key = (data.get("api_key") or "").strip()
            if key and not key.startswith("sk-ant-") and not key.startswith("sk-"):
                return jsonify({"error": "Anthropic keys start with 'sk-ant-'; "
                                         "OpenAI keys start with 'sk-'."}), 400
            cfg["api_key"] = key or None
            cfg["provider"] = "openai" if key.startswith("sk-") and not key.startswith("sk-ant-") else "anthropic"
        if "model" in data and data["model"]:
            cfg["model"] = data["model"]
        _ai_save_config(cfg)
    masked = None
    if cfg.get("api_key"):
        k = cfg["api_key"]
        masked = k[:11] + "…" + k[-4:]
    return jsonify({
        "configured":     bool(cfg.get("api_key")),
        "provider":       cfg.get("provider", "anthropic"),
        "model":          cfg.get("model", _AI_MODEL),
        "key_preview":    masked,
        "config_path":    _AI_CONFIG_FILE,
    })


def _call_anthropic(api_key: str, system: str, messages: list[dict], model: str) -> str:
    """POST to Anthropic's /v1/messages.  Returns assistant text or raises."""
    body = json.dumps({
        "model": model,
        "max_tokens": _AI_MAX_TOKENS,
        "system": system,
        "messages": messages,
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "User-Agent": "ChurnLence/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    blocks = payload.get("content") or []
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


def _call_openai(api_key: str, system: str, messages: list[dict], model: str) -> str:
    body = json.dumps({
        "model": model or "gpt-4o-mini",
        "max_tokens": _AI_MAX_TOKENS,
        "messages": [{"role": "system", "content": system}] + messages,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "ChurnLence/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    return (payload.get("choices") or [{}])[0].get("message", {}).get("content", "")


@app.route("/api/ai/chat", methods=["POST"])
def ai_chat():
    data = request.get_json(force=True, silent=True) or {}
    user_msg = (data.get("message") or "").strip()
    history = data.get("history") or []
    chart_symbol = data.get("chart_symbol")
    portfolio_id = data.get("portfolio_id") or 1
    mode = (data.get("mode") or "swing").lower()
    if not user_msg:
        return jsonify({"error": "message required"}), 400

    snap = _portfolio_snapshot(int(portfolio_id), mode=mode)
    # Load up to 20 most-recent memory rows (preference + fact, plus summaries)
    # so Jarvis remembers the user across sessions.
    memory: list[dict] = []
    try:
        with direct_db() as mdb:
            rows = mdb.execute(
                "SELECT kind, key, value FROM jarvis_memory "
                "WHERE portfolio_id = ? AND kind IN ('preference','fact','summary') "
                "ORDER BY created_at DESC LIMIT 20",
                (int(portfolio_id),),
            ).fetchall()
            memory = [dict(r) for r in rows]
    except Exception as exc:
        app.logger.warning("jarvis memory load failed: %s", exc)
    system = _ai_system_prompt(snap if not snap.get("error") else None,
                               chart_symbol, mode, memory=memory)
    cfg = _ai_load_config()
    api_key = cfg.get("api_key")

    if not api_key:
        # Demo mode — canned helpful response, no network call
        return jsonify({
            "reply":     _ai_demo_reply(user_msg, snap),
            "model":     "demo",
            "configured": False,
        })

    # Build the conversation messages array (history + this turn)
    messages = []
    for h in history[-12:]:  # cap context to last 12 turns
        role = h.get("role")
        content = h.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_msg})

    provider = cfg.get("provider", "anthropic")
    model = cfg.get("model") or (_AI_MODEL if provider == "anthropic" else "gpt-4o-mini")
    try:
        if provider == "openai":
            reply = _call_openai(api_key, system, messages, model)
        else:
            reply = _call_anthropic(api_key, system, messages, model)
        return jsonify({"reply": reply, "model": model, "configured": True})
    except urllib.error.HTTPError as exc:
        body_txt = exc.read().decode("utf-8", errors="ignore")[:400]
        return jsonify({"error": f"API error {exc.code}: {body_txt}"}), 502
    except Exception as exc:
        return jsonify({"error": f"AI call failed: {exc}"}), 502


# ---------------------------------------------------------------------------
# WhaleAlert — large on-chain transfers (opt-in, requires API key)
# ---------------------------------------------------------------------------

_whale_cache: dict[str, tuple[float, list]] = {}
_WHALE_TTL = 90  # seconds


@app.route("/api/whales")
def whales():
    """Recent large transactions from WhaleAlert.  Optional — returns an empty
    list with a hint if WHALEALERT_API_KEY isn't set.

    ?min_value=<usd>   default 1_000_000
    ?currency=<sym>    e.g. 'btc', 'eth', 'sol' (lowercased symbol)
    """
    if not WHALEALERT_KEY:
        return jsonify({
            "configured": False,
            "transactions": [],
            "hint": "Set the WHALEALERT_API_KEY environment variable to enable whale alerts. "
                    "Free key: https://whale-alert.io/ (signup required).",
        })
    try:
        min_value = int(request.args.get("min_value") or 1_000_000)
    except ValueError:
        min_value = 1_000_000
    currency = (request.args.get("currency") or "").lower().strip()
    cache_key = f"{currency}:{min_value}"
    now = time.time()
    cached = _whale_cache.get(cache_key)
    if cached and now - cached[0] < _WHALE_TTL:
        return jsonify({"configured": True, "transactions": cached[1]})

    start = int(now) - 60 * 30  # last 30 minutes
    url = f"https://api.whale-alert.io/v1/transactions?api_key={WHALEALERT_KEY}&min_value={min_value}&start={start}"
    if currency:
        url += f"&currency={currency}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ChurnLence/1.0"}), timeout=8) as r:
            payload = json.loads(r.read())
    except Exception as exc:
        app.logger.warning("WhaleAlert fetch failed: %s", exc)
        return jsonify({"configured": True, "transactions": cached[1] if cached else [], "error": str(exc)})

    txs = payload.get("transactions") or []
    out = []
    for t in txs[:30]:
        out.append({
            "timestamp": t.get("timestamp"),
            "blockchain": t.get("blockchain"),
            "symbol":    (t.get("symbol") or "").upper(),
            "amount":    t.get("amount"),
            "amount_usd": t.get("amount_usd"),
            "from":      (t.get("from") or {}).get("owner_type", "unknown"),
            "from_owner": (t.get("from") or {}).get("owner") or "",
            "to":        (t.get("to") or {}).get("owner_type", "unknown"),
            "to_owner":  (t.get("to") or {}).get("owner") or "",
            "transaction_type": t.get("transaction_type") or "transfer",
            "hash":      t.get("hash"),
        })
    _whale_cache[cache_key] = (now, out)
    return jsonify({"configured": True, "transactions": out})


# ---------------------------------------------------------------------------
# Memecoin scanner — GeckoTerminal trending / new pools (free, no API key)
# ---------------------------------------------------------------------------

_scanner_cache: dict[str, tuple[float, list]] = {}
_SCANNER_TTL = 60  # seconds — be polite with the free API


def _scanner_fetch(network: str, view: str) -> list[dict]:
    """Pull trending or new pools for a given chain via GeckoTerminal.

    network: 'solana' / 'eth' / 'base' / etc. (we expose 'solana' first).
    view:    'trending_pools' | 'new_pools'

    Returns a normalised list — symbol, name, mc/liq, 1h/24h%, age, dexscreener URL.
    """
    cache_key = f"{network}:{view}"
    now = time.time()
    cached = _scanner_cache.get(cache_key)
    if cached and now - cached[0] < _SCANNER_TTL:
        return cached[1]

    url = f"https://api.geckoterminal.com/api/v2/networks/{network}/{view}?include=base_token"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "ChurnLence/1.0",
            "Accept": "application/json;version=20230302",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
    except Exception as exc:
        app.logger.warning("scanner fetch failed [%s/%s]: %s", network, view, exc)
        return cached[1] if cached else []

    pools = payload.get("data") or []
    included = {item["id"]: item for item in (payload.get("included") or [])}
    out: list[dict] = []
    for p in pools:
        a = p.get("attributes") or {}
        rels = (p.get("relationships") or {}).get("base_token", {}).get("data") or {}
        token_meta = included.get(rels.get("id"), {}).get("attributes", {}) if rels else {}
        try:
            price_change_h1  = float((a.get("price_change_percentage") or {}).get("h1")  or 0)
            price_change_h24 = float((a.get("price_change_percentage") or {}).get("h24") or 0)
            price_change_h6  = float((a.get("price_change_percentage") or {}).get("h6")  or 0)
            volume_h24       = float((a.get("volume_usd") or {}).get("h24") or 0)
            transactions_h24 = (a.get("transactions") or {}).get("h24") or {}
            buys_h24  = int(transactions_h24.get("buys")  or 0)
            sells_h24 = int(transactions_h24.get("sells") or 0)
            liquidity = float(a.get("reserve_in_usd") or 0)
            mc        = float(a.get("market_cap_usd") or a.get("fdv_usd") or 0)
        except (TypeError, ValueError):
            continue

        symbol = (token_meta.get("symbol") or "").upper()
        name   = token_meta.get("name") or symbol or "?"
        token_addr = token_meta.get("address") or ""
        # Pool address is in the pool's own attributes
        pool_addr = a.get("address") or ""
        out.append({
            "symbol":     symbol,
            "name":       name,
            "price_usd":  float(a.get("base_token_price_usd") or 0),
            "change_1h":  round(price_change_h1, 2),
            "change_6h":  round(price_change_h6, 2),
            "change_24h": round(price_change_h24, 2),
            "volume_24h": round(volume_h24, 2),
            "liquidity":  round(liquidity, 2),
            "market_cap": round(mc, 2),
            "buys_24h":   buys_h24,
            "sells_24h":  sells_h24,
            "buy_sell_ratio": round(buys_h24 / max(1, sells_h24), 2),
            "pool_created_at": a.get("pool_created_at"),
            "dex":            a.get("dex_id") or "",
            "token_address":  token_addr,
            "pool_address":   pool_addr,
            "dexscreener_url": f"https://dexscreener.com/{network}/{pool_addr}" if pool_addr else "",
            "geckoterminal_url": f"https://www.geckoterminal.com/{network}/pools/{pool_addr}" if pool_addr else "",
            "score":           _scanner_score(price_change_h24, volume_h24, liquidity, buys_h24, sells_h24),
        })

    out.sort(key=lambda x: -x["score"])
    _scanner_cache[cache_key] = (now, out)
    return out


def _scanner_score(change_24h: float, volume_24h: float, liquidity: float,
                   buys: int, sells: int) -> float:
    """Crude 'is this real momentum or a rug?' score.

    Rewards: positive 24h move with high volume + healthy liquidity + buyers
             outnumbering sellers.  Penalises: dust liquidity (rugs), wash-
             traded pumps where sells dominate.
    """
    if liquidity < 5_000:                # below $5k liq is almost always a rug
        return change_24h * 0.1
    momentum = max(0, change_24h)
    vol_factor = min(volume_24h / 100_000, 5)   # cap so megacaps don't dominate
    liq_factor = min(liquidity / 50_000, 5)
    flow = (buys + 1) / (sells + 1)             # bias to buy pressure
    return momentum * vol_factor * liq_factor * min(flow, 4)


@app.route("/api/scanner/<view>")
def scanner(view: str):
    """Returns trending or new pools.  view ∈ {trending, new}.  ?network=solana|eth|base.
    ?min_liq=<usd> filters out illiquid junk; default 5_000."""
    if view not in ("trending", "new"):
        return jsonify({"error": "view must be 'trending' or 'new'"}), 400
    network = (request.args.get("network") or "solana").lower()
    if network not in ("solana", "eth", "base", "bsc", "polygon_pos", "arbitrum"):
        return jsonify({"error": "unsupported network"}), 400
    try:
        min_liq = float(request.args.get("min_liq") or 5000)
    except ValueError:
        min_liq = 5000
    api_view = "trending_pools" if view == "trending" else "new_pools"
    pools = _scanner_fetch(network, api_view)
    if min_liq:
        pools = [p for p in pools if p["liquidity"] >= min_liq]
    return jsonify({
        "network": network,
        "view": view,
        "count": len(pools),
        "pools": pools[:50],
        "as_of": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/api/portfolios/<int:pid>/signal-events")
def list_signal_events(pid: int):
    db = get_db()
    rows = db.execute(
        "SELECT symbol, from_signal, to_signal, price, reason, created_at "
        "FROM signal_events WHERE portfolio_id = ? "
        "ORDER BY created_at DESC LIMIT 50",
        (pid,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# ---------------------------------------------------------------------------
# Background signal-transition watcher → email alerts
# ---------------------------------------------------------------------------

_last_signals: dict[tuple[int, str], str] = {}


def _send_discord_alert(webhook: str, symbol: str, from_sig: str | None, to_sig: str,
                        price: float, reason: str) -> None:
    """Post a single signal-flip event to a Discord webhook URL.

    Uses Discord's embed format so the message is visually rich (colored bar,
    title, fields).  Color = green for BUY, red for SELL, grey for HOLD.
    """
    if not webhook or not webhook.startswith("https://"):
        return
    color = 0x00FF9C if to_sig == "BUY" else 0xFF5577 if to_sig == "SELL" else 0x808080
    payload = {
        "username": "ChurnLence",
        "embeds": [{
            "title": f"{symbol}  →  {to_sig}",
            "description": reason or "",
            "color": color,
            "fields": [
                {"name": "From",  "value": from_sig or "—", "inline": True},
                {"name": "To",    "value": to_sig,          "inline": True},
                {"name": "Price", "value": f"${price:,.6g}", "inline": True},
            ],
            "footer": {"text": "ChurnLence · Overkill EMA signal"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }],
    }
    try:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(webhook, data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "ChurnLence/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            resp.read()  # discard
    except Exception as exc:
        app.logger.warning("discord webhook send failed: %s", exc)


def _send_alert_email(to: str, symbol: str, from_sig: str | None, to_sig: str,
                      price: float, reason: str) -> None:
    if not (SMTP_HOST and SMTP_USER and SMTP_PASS and to):
        return
    msg = EmailMessage()
    msg["Subject"] = f"ChurnLence: {symbol} → {to_sig}"
    msg["From"] = SMTP_FROM or SMTP_USER
    msg["To"] = to
    body = (
        f"Signal transition detected:\n\n"
        f"  {symbol}: {from_sig or '—'} → {to_sig}\n"
        f"  Price: {price:.4f}\n"
        f"  Reason: {reason}\n\n"
        f"— ChurnLence\n"
    )
    msg.set_content(body)
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
    except Exception as exc:
        app.logger.warning("email alert failed: %s", exc)


_THESIS_COOLDOWN_SEC = 30 * 60   # 30 min between same-signal re-fires
_RULE_COOLDOWN_SEC   = 4 * 3600  # 4 h between same-rule re-fires


def _fire_alert(db, pid: int, sym: str, from_sig: str | None, to_sig: str,
                price: float, reason: str,
                email: str | None, email_on: int,
                discord_webhook: str | None, discord_on: int) -> None:
    """Insert a signal_events row + dispatch email/Discord per portfolio prefs.
    Used by both the default Overkill watcher and the new thesis/rule watchers
    so delivery stays uniform."""
    db.execute(
        "INSERT INTO signal_events(portfolio_id, symbol, from_signal, "
        "to_signal, price, reason) VALUES (?, ?, ?, ?, ?, ?)",
        (pid, sym, from_sig, to_sig, price, reason),
    )
    db.commit()
    if email_on and email:
        _send_alert_email(email, sym, from_sig, to_sig, price, reason)
    if discord_on and discord_webhook:
        _send_discord_alert(discord_webhook, sym, from_sig, to_sig, price, reason)


def _evaluate_alert_rule(rule: dict, q, prev_to: str | None) -> tuple[bool, str]:
    """Returns (fired, reason).  Caller handles cooldown + delivery."""
    kind = rule.get("kind")
    params = rule.get("params") or {}
    if kind == "price_above":
        v = float(params.get("value"))
        if q.price > v:
            return True, f"Price ${q.price:,.6g} crossed above ${v:,.6g}"
    elif kind == "price_below":
        v = float(params.get("value"))
        if q.price < v:
            return True, f"Price ${q.price:,.6g} dropped below ${v:,.6g}"
    elif kind == "pct_move_24h":
        pct = float(params.get("pct"))
        cur = q.change_pct or 0.0
        # Positive threshold = "alert when up at least X%"; negative = "down at least |X|%".
        if pct >= 0 and cur >= pct:
            return True, f"24h move {cur:+.2f}% met +{pct}% threshold"
        if pct < 0 and cur <= pct:
            return True, f"24h move {cur:+.2f}% met {pct}% threshold"
    elif kind == "volume_spike":
        thr = float(params.get("threshold"))
        if (q.rvol or 0) >= thr:
            return True, f"Relative volume {q.rvol:.2f}× ≥ {thr}× avg"
    elif kind == "signal_flip":
        if prev_to and prev_to != q.signal:
            return True, f"Signal flipped {prev_to} → {q.signal}: {q.signal_reason}"
    return False, ""


def _signal_watcher_loop():
    while True:
        try:
            with direct_db() as db:
                portfolios = db.execute(
                    "SELECT p.id, p.name, ap.email, ap.enabled, ap.daily_digest, "
                    "ap.digest_hour_utc, ap.last_digest_date, "
                    "ap.discord_webhook, ap.discord_enabled "
                    "FROM portfolios p "
                    "LEFT JOIN alert_prefs ap ON ap.portfolio_id = p.id"
                ).fetchall()
                now = datetime.now(timezone.utc)
                today_str = now.strftime("%Y-%m-%d")
                for p in portfolios:
                    pid = p["id"]
                    email_on    = p["enabled"] or 0
                    discord_on  = p["discord_enabled"] or 0
                    email       = p["email"]
                    discord_url = p["discord_webhook"]

                    # Gather holdings ∪ watchlist symbols (dedupe to limit
                    # yfinance hits) — watchlist is the new bit.
                    holds = db.execute(
                        "SELECT DISTINCT symbol FROM holdings WHERE portfolio_id = ?",
                        (pid,),
                    ).fetchall()
                    watches = db.execute(
                        "SELECT DISTINCT symbol FROM watchlist WHERE portfolio_id = ?",
                        (pid,),
                    ).fetchall()
                    all_syms = {h["symbol"] for h in holds} | {w["symbol"] for w in watches}

                    # Cache theses & rules once per loop to avoid N queries
                    theses = _load_theses(db, pid)
                    theses_by_sym: dict[str, list[dict]] = {}
                    for t in theses:
                        if t.get("enabled"):
                            theses_by_sym.setdefault(t["symbol"], []).append(t)
                    rules = _load_alert_rules(db, pid)
                    rules_by_sym: dict[str, list[dict]] = {}
                    for r in rules:
                        if r.get("enabled"):
                            rules_by_sym.setdefault(r["symbol"], []).append(r)

                    for sym in sorted(all_syms):
                        q = fetch_quote(sym)
                        if q is None:
                            continue
                        prev_q = _prev_quotes.get(sym)
                        key = (pid, sym)
                        prev_to = _last_signals.get(key)

                        # --- default Overkill per-transition alert ---
                        # Only fires if user actually holds the symbol (watchlist-
                        # only symbols get the same alert via signal_flip rule).
                        is_holding = any(h["symbol"] == sym for h in holds)
                        if is_holding:
                            if prev_to is None:
                                _last_signals[key] = q.signal
                            elif prev_to != q.signal:
                                _fire_alert(db, pid, sym, prev_to, q.signal,
                                            q.price, q.signal_reason,
                                            email, email_on, discord_url, discord_on)
                                _last_signals[key] = q.signal

                        # --- custom thesis evaluation ---
                        for t in theses_by_sym.get(sym, []):
                            hit = _evaluate_thesis(t, q, prev_q)
                            if not hit:
                                continue
                            new_sig, name = hit
                            # Debounce: skip if same signal recently fired
                            last_sig = t.get("last_fired_signal")
                            last_at  = t.get("last_fired_at")
                            if last_sig == new_sig and last_at:
                                try:
                                    dt = datetime.fromisoformat(last_at.replace(" ", "T"))
                                    if dt.tzinfo is None:
                                        dt = dt.replace(tzinfo=timezone.utc)
                                    if (now - dt).total_seconds() < _THESIS_COOLDOWN_SEC:
                                        continue
                                except ValueError:
                                    pass
                            reason = f"Thesis: {name} → {new_sig}"
                            _fire_alert(db, pid, sym, last_sig, new_sig,
                                        q.price, reason,
                                        email, email_on, discord_url, discord_on)
                            db.execute(
                                "UPDATE coin_theses SET last_fired_signal = ?, "
                                "last_fired_at = ? WHERE id = ?",
                                (new_sig, now.isoformat(), t["id"]),
                            )
                            db.commit()
                            # Update in-memory copy so next-symbol iteration
                            # sees the new debounce state.
                            t["last_fired_signal"] = new_sig
                            t["last_fired_at"]     = now.isoformat()

                        # --- generic alert rules (price/movement/volume/flip) ---
                        for r in rules_by_sym.get(sym, []):
                            fired, reason = _evaluate_alert_rule(r, q, prev_to)
                            if not fired:
                                continue
                            last_at = r.get("last_fired_at")
                            if last_at:
                                try:
                                    dt = datetime.fromisoformat(last_at.replace(" ", "T"))
                                    if dt.tzinfo is None:
                                        dt = dt.replace(tzinfo=timezone.utc)
                                    if (now - dt).total_seconds() < _RULE_COOLDOWN_SEC:
                                        continue
                                except ValueError:
                                    pass
                            tag = f"Alert ({r['kind']}): {reason}"
                            _fire_alert(db, pid, sym, None, q.signal,
                                        q.price, tag,
                                        email, email_on, discord_url, discord_on)
                            db.execute(
                                "UPDATE alert_rules SET last_fired_at = ? WHERE id = ?",
                                (now.isoformat(), r["id"]),
                            )
                            db.commit()
                            r["last_fired_at"] = now.isoformat()

                        _prev_quotes[sym] = q

                    # --- daily digest (fire once per UTC day at the chosen hour) ---
                    if (p["daily_digest"] and p["email"] and SMTP_HOST and SMTP_USER and SMTP_PASS
                            and now.hour >= (p["digest_hour_utc"] or 13)
                            and (p["last_digest_date"] or "") != today_str):
                        try:
                            dig = _build_digest(pid)
                            subject, body = _format_digest_text(pid, p["name"] or "Portfolio", dig)
                            msg = EmailMessage()
                            msg["Subject"] = subject
                            msg["From"] = SMTP_FROM or SMTP_USER
                            msg["To"] = p["email"]
                            msg.set_content(body)
                            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
                                s.starttls()
                                s.login(SMTP_USER, SMTP_PASS)
                                s.send_message(msg)
                            db.execute(
                                "UPDATE alert_prefs SET last_digest_date = ? WHERE portfolio_id = ?",
                                (today_str, pid),
                            )
                            db.commit()
                        except Exception as exc:
                            app.logger.warning("daily digest send failed for pid=%s: %s", pid, exc)
        except Exception as exc:
            app.logger.warning("signal watcher loop error: %s", exc)
        time.sleep(ALERT_INTERVAL)


@app.route("/api/portfolios/<int:pid>/stream")
def stream(pid: int):
    """Server-Sent Events — pushes ONLY when something materially changed
    (prices moved, signals flipped, holdings edited).  A keep-alive comment
    fires every STREAM_INTERVAL seconds so the connection doesn't close.

    Sending only deltas is the single biggest perf win — the client used to
    re-render every 5s even when nothing moved, which animated charts and
    rebuilt DOM for no reason."""
    def _digest(snap: dict) -> str:
        # Materially-changed fingerprint: per-row symbol/price/signal + totals.
        # Round price to 6 sig figs so micro-jitter doesn't spam.
        rows = snap.get("rows") or []
        parts = [f"{r['symbol']}|{round(r.get('price') or 0, 6)}|{r.get('signal')}"
                 for r in rows]
        t = snap.get("totals") or {}
        parts.append(f"V{round(t.get('value') or 0, 2)}|P{round(t.get('pl') or 0, 2)}")
        return hashlib.sha1("\n".join(parts).encode()).hexdigest()

    mode = (request.args.get("mode") or "swing").lower()
    # Day mode pushes more often because intraday prices move faster.
    interval = max(2, STREAM_INTERVAL // 2) if mode == "day" else STREAM_INTERVAL

    def generate() -> Iterable[bytes]:
        last_digest = None
        idle_ticks = 0
        first = _portfolio_snapshot(pid, mode=mode)
        yield f"data: {json.dumps(first)}\n\n".encode()
        last_digest = _digest(first)
        while True:
            time.sleep(interval)
            snap = _portfolio_snapshot(pid, mode=mode)
            digest = _digest(snap)
            if digest == last_digest:
                idle_ticks += 1
                yield b": keep-alive\n\n"
                if idle_ticks >= 6:
                    time.sleep(interval)
                continue
            idle_ticks = 0
            last_digest = digest
            yield f"data: {json.dumps(snap)}\n\n".encode()

    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


def _open_browser_when_ready(port: int) -> None:
    """Background helper that polls the local port and opens the browser
    once Flask is actually serving. Used by the packaged .exe so a user
    double-click immediately lands on the app."""
    import socket
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                webbrowser.open(f"http://localhost:{port}/", new=2)
                return
        except OSError:
            time.sleep(0.25)


def _print_banner(port: int) -> None:
    name = "ChurnLence"
    bar  = "=" * 60
    print(bar)
    print(f"  {name} — open the app at: http://localhost:{port}")
    if DEMO_MODE:
        print("  Mode: DEMO (synthetic prices, no internet needed)")
    print(f"  Database: {DB_PATH}")
    print("  Close this window to stop the server.")
    print(bar, flush=True)


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    threading.Thread(target=_signal_watcher_loop, daemon=True, name="signal-watcher").start()
    # When running as the packaged exe (or when explicitly opted in) auto-open
    # the user's default browser the moment the port starts listening.
    if getattr(sys, "frozen", False) or os.environ.get("CHURNLENCE_OPEN_BROWSER") == "1":
        threading.Thread(target=_open_browser_when_ready, args=(port,), daemon=True).start()
    _print_banner(port)
    # Threaded=True lets SSE streams + REST requests interleave on one process.
    # use_reloader=False is required when frozen (PyInstaller) and is friendlier
    # in production anyway.
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True, use_reloader=False)
