"""ChurnLence portfolio tracker with live market data and Overkill-style indicators."""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable

import yfinance as yf
from flask import Flask, Response, g, jsonify, render_template, request

app = Flask(__name__)

DB_PATH = os.environ.get("CHURNLENCE_DB", os.path.join(os.path.dirname(__file__), "portfolio.db"))
DEMO_MODE = os.environ.get("CHURNLENCE_DEMO", "").lower() in ("1", "true", "yes")
QUOTE_TTL = 2 if DEMO_MODE else 15  # seconds — shorter in demo so prices tick visibly
STREAM_INTERVAL = 5  # seconds between SSE pushes

_quote_cache: dict[str, tuple[float, dict]] = {}
_quote_lock = threading.Lock()


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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id);
"""


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


def _overkill_signal(price: float, e9: float | None, e21: float | None, e50: float | None, e200: float | None) -> tuple[str, str]:
    """Overkill-style read: buy near/below rising MAs, sell when price trades at a premium."""
    if None in (e9, e21, e50, e200):
        return "HOLD", "Not enough history for EMAs"
    stack_bull = e9 > e21 > e50 > e200  # type: ignore[operator]
    stack_bear = e9 < e21 < e50 < e200  # type: ignore[operator]
    near_ma = abs(price - e21) / price <= 0.015  # within 1.5% of 21 EMA
    premium = price > e21 * 1.08  # 8%+ extended above 21 EMA
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


def fetch_quote(symbol: str, force: bool = False) -> Quote | None:
    symbol = symbol.upper().strip()
    if not symbol:
        return None
    now = time.time()
    with _quote_lock:
        cached = _quote_cache.get(symbol)
        if cached and not force and now - cached[0] < QUOTE_TTL:
            return Quote(**cached[1])

    dates: list[str] = []
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    currency = "USD"
    name = symbol
    ticker = None

    if not DEMO_MODE:
        try:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period="1y", interval="1d", auto_adjust=False)
            if not hist.empty:
                closes = [float(x) for x in hist["Close"].tolist()]
                highs = [float(x) for x in hist["High"].tolist()]
                lows = [float(x) for x in hist["Low"].tolist()]
                dates = [d.strftime("%Y-%m-%d") for d in hist.index]
        except Exception as exc:
            app.logger.warning("yfinance history failed for %s: %s", symbol, exc)

    if not closes:
        if DEMO_MODE:
            dates, highs, lows, closes, currency, name = _demo_history(symbol)
        else:
            return None

    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    ema50 = _ema(closes, 50)
    ema200 = _ema(closes, 200)
    atr_series = _atr(highs, lows, closes, 14) if highs and lows else []

    price = closes[-1]
    prev_close = closes[-2] if len(closes) > 1 else price
    change = price - prev_close
    change_pct = (change / prev_close * 100) if prev_close else 0.0

    if not DEMO_MODE:
        # Best-effort live price + metadata
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
        # Add a small jitter on each non-cached fetch to simulate a ticking quote.
        jitter = random.uniform(-0.006, 0.006)
        price = max(0.01, price * (1 + jitter))
        change = price - prev_close
        change_pct = (change / prev_close * 100) if prev_close else 0.0

    e9 = ema9[-1] if ema9 else None
    e21 = ema21[-1] if ema21 else None
    e50 = ema50[-1] if len(ema50) >= 50 else None
    e200 = ema200[-1] if len(ema200) >= 200 else None
    atr_last = atr_series[-1] if atr_series else None
    atr_pct = (atr_last / price * 100) if (atr_last and price) else None
    stop_ma = round(e21 * 0.97, 4) if e21 else None
    stop_atr = round(price - atr_last * 2, 4) if atr_last else None
    signal, reason = _overkill_signal(price, e9, e21, e50, e200)

    history = []
    take = min(180, len(closes))
    for i in range(len(closes) - take, len(closes)):
        history.append({
            "date": dates[i],
            "close": round(closes[i], 4),
            "ema9": round(ema9[i], 4) if ema9 else None,
            "ema21": round(ema21[i], 4) if ema21 else None,
            "ema50": round(ema50[i], 4) if i >= 49 else None,
            "ema200": round(ema200[i], 4) if i >= 199 else None,
            "atr": round(atr_series[i], 4) if atr_series else None,
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
        _quote_cache[symbol] = (now, quote.as_dict())
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


def _portfolio_snapshot(portfolio_id: int) -> dict:
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
        q = fetch_quote(h["symbol"])
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


@app.route("/api/portfolios/<int:pid>", methods=["DELETE"])
def delete_portfolio(pid: int):
    db = get_db()
    db.execute("DELETE FROM portfolios WHERE id = ?", (pid,))
    db.commit()
    return jsonify({"ok": True})


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
    return jsonify(_portfolio_snapshot(pid))


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
    q = fetch_quote(symbol, force=request.args.get("force") == "1")
    if q is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(q.as_dict())


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


@app.route("/api/portfolios/<int:pid>/stream")
def stream(pid: int):
    """Server-Sent Events — live portfolio snapshot every STREAM_INTERVAL seconds."""
    def generate() -> Iterable[bytes]:
        while True:
            snap = _portfolio_snapshot(pid)
            yield f"data: {json.dumps(snap)}\n\n".encode()
            time.sleep(STREAM_INTERVAL)
    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False, threaded=True)
