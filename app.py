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
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
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


def _demo_history(symbol: str) -> tuple[list[str], list[float], list[float], list[float], str, str]:
    """Deterministic synthetic OHLC history for offline/demo use."""
    seed = int(hashlib.sha256(symbol.encode()).hexdigest(), 16) % (2**32)
    rng = random.Random(seed)
    base = 50 + rng.random() * 900
    n = 260
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    p = base
    drift = (rng.random() - 0.4) * 0.0008
    for _ in range(n):
        shock = rng.gauss(0, 0.018)
        p = max(1.0, p * (1 + drift + shock))
        closes.append(p)
        intraday = abs(rng.gauss(0, 0.012)) + 0.004
        highs.append(p * (1 + intraday))
        lows.append(p * (1 - intraday))
    today = datetime.now(timezone.utc).date()
    dates = [(today - timedelta(days=n - 1 - i)).strftime("%Y-%m-%d") for i in range(n)]
    currency = "USD"
    name = f"{symbol} (demo)"
    return dates, highs, lows, closes, currency, name


def _coingecko_history(coin_id: str, days: int = 365) -> tuple[list[str], list[float], list[float], list[float], str, str] | None:
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
    return dates, highs, lows, closes, "USD", name


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

    if not DEMO_MODE:
        try:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period=yf_period, interval=yf_interval, auto_adjust=False)
            if not hist.empty:
                closes = [float(x) for x in hist["Close"].tolist()]
                highs = [float(x) for x in hist["High"].tolist()]
                lows = [float(x) for x in hist["Low"].tolist()]
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
                dates, highs, lows, closes, currency, name = cg
                used_coingecko = True

    if not closes:
        if DEMO_MODE:
            dates, highs, lows, closes, currency, name = _demo_history(symbol)
        else:
            return None

    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    ema50 = _ema(closes, 50)
    ema200 = _ema(closes, 200) if mode == "swing" else []
    atr_series = _atr(highs, lows, closes, 14) if highs and lows else []

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
    }


def _portfolio_snapshot(portfolio_id: int, mode: str = "swing") -> dict:
    with direct_db() as db:
        portfolio = db.execute("SELECT id, name FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone()
        if not portfolio:
            return {"error": "portfolio not found"}
        holdings = db.execute(
            "SELECT id, symbol, shares, cost_basis, note FROM holdings WHERE portfolio_id = ? ORDER BY symbol",
            (portfolio_id,),
        ).fetchall()

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
            "stop_loss": q.stop_loss,
            "stop_atr": q.stop_atr,
            "signal": q.signal,
            "signal_reason": q.signal_reason,
            "note": h["note"],
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
        db.execute(
            "INSERT INTO alert_prefs(portfolio_id, email, enabled, daily_digest, digest_hour_utc, updated_at) "
            "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(portfolio_id) DO UPDATE SET email = excluded.email, "
            "enabled = excluded.enabled, daily_digest = excluded.daily_digest, "
            "digest_hour_utc = excluded.digest_hour_utc, updated_at = CURRENT_TIMESTAMP",
            (pid, email, enabled, daily, hour),
        )
        db.commit()
    row = db.execute(
        "SELECT email, enabled, daily_digest, digest_hour_utc, last_digest_date, updated_at "
        "FROM alert_prefs WHERE portfolio_id = ?",
        (pid,),
    ).fetchone()
    return jsonify({
        "email":            row["email"] if row else None,
        "enabled":          bool(row["enabled"]) if row else False,
        "daily_digest":     bool(row["daily_digest"]) if row else False,
        "digest_hour_utc":  int(row["digest_hour_utc"]) if row else 13,
        "last_digest_date": row["last_digest_date"] if row else None,
        "updated_at":       row["updated_at"] if row else None,
        "smtp_configured":  bool(SMTP_HOST and SMTP_USER and SMTP_PASS),
    })


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


def _signal_watcher_loop():
    while True:
        try:
            with direct_db() as db:
                portfolios = db.execute(
                    "SELECT p.id, p.name, ap.email, ap.enabled, ap.daily_digest, "
                    "ap.digest_hour_utc, ap.last_digest_date "
                    "FROM portfolios p "
                    "LEFT JOIN alert_prefs ap ON ap.portfolio_id = p.id"
                ).fetchall()
                now = datetime.now(timezone.utc)
                today_str = now.strftime("%Y-%m-%d")
                for p in portfolios:
                    pid = p["id"]
                    # --- per-transition signal alerts ---
                    holds = db.execute(
                        "SELECT DISTINCT symbol FROM holdings WHERE portfolio_id = ?",
                        (pid,),
                    ).fetchall()
                    for h in holds:
                        sym = h["symbol"]
                        q = fetch_quote(sym)
                        if q is None:
                            continue
                        key = (pid, sym)
                        prev = _last_signals.get(key)
                        if prev is None:
                            _last_signals[key] = q.signal
                            continue
                        if prev == q.signal:
                            continue
                        db.execute(
                            "INSERT INTO signal_events(portfolio_id, symbol, from_signal, "
                            "to_signal, price, reason) VALUES (?, ?, ?, ?, ?, ?)",
                            (pid, sym, prev, q.signal, q.price, q.signal_reason),
                        )
                        db.commit()
                        if p["enabled"] and p["email"]:
                            _send_alert_email(p["email"], sym, prev, q.signal,
                                              q.price, q.signal_reason)
                        _last_signals[key] = q.signal

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
