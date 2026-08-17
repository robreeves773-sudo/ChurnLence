"""TradingView → Webot/Pionex webhook relay.

Receives TradingView alert webhooks, verifies a shared secret, and places
market orders on Webot/Pionex. Starts in DRY-RUN mode: orders are logged,
not sent, until LIVE_TRADING=true is set. A phone-friendly dashboard at
/dashboard?key=<secret> shows every signal received and what happened.
"""

from __future__ import annotations

import hmac
import html
import json
import logging
import os
import sqlite3
import time
from contextlib import closing

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from pionex import PionexClient, PionexError, base_coin, normalize_symbol

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("relay")

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
LIVE_TRADING = os.environ.get("LIVE_TRADING", "false").lower() == "true"
MAX_ORDER_USD = float(os.environ.get("MAX_ORDER_USD", "100"))
DEFAULT_AMOUNT_USD = float(os.environ.get("DEFAULT_AMOUNT_USD", "25"))
API_BASE_URL = os.environ.get("PIONEX_BASE_URL", "https://api.pionex.com")
DB_PATH = os.environ.get("DB_PATH", "relay.db")

app = FastAPI(title="Webot relay", docs_url=None, redoc_url=None)


def get_client() -> PionexClient:
    key, secret = os.environ.get("PIONEX_API_KEY"), os.environ.get("PIONEX_API_SECRET")
    if not key or not secret:
        raise PionexError("PIONEX_API_KEY / PIONEX_API_SECRET not configured")
    return PionexClient(key, secret, base_url=API_BASE_URL)


# --- event log --------------------------------------------------------------
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL, action TEXT, symbol TEXT, detail TEXT, status TEXT)""")
    return conn


def record(action: str, symbol: str, detail: str, status: str) -> None:
    with closing(db()) as conn, conn:
        conn.execute("INSERT INTO events (ts, action, symbol, detail, status) VALUES (?,?,?,?,?)",
                     (time.time(), action, symbol, detail, status))


def check_secret(supplied: str | None) -> None:
    if not WEBHOOK_SECRET:
        raise HTTPException(500, "Server misconfigured: WEBHOOK_SECRET is not set")
    if not supplied or not hmac.compare_digest(supplied, WEBHOOK_SECRET):
        raise HTTPException(403, "Bad secret")


# --- webhook ----------------------------------------------------------------
@app.post("/webhook")
async def webhook(request: Request) -> JSONResponse:
    try:
        payload = json.loads(await request.body())
    except ValueError:
        raise HTTPException(400, "Body must be JSON")

    check_secret(payload.get("secret"))

    action = str(payload.get("action", "")).lower()
    if action not in ("buy", "sell"):
        raise HTTPException(400, "action must be 'buy' or 'sell'")
    raw_symbol = payload.get("symbol")
    if not raw_symbol:
        raise HTTPException(400, "symbol is required")
    symbol = normalize_symbol(str(raw_symbol))

    if action == "buy":
        amount = float(payload.get("amount_usd", DEFAULT_AMOUNT_USD))
        if amount <= 0 or amount > MAX_ORDER_USD:
            record(action, symbol, f"amount_usd={amount}", "rejected: exceeds MAX_ORDER_USD")
            raise HTTPException(400, f"amount_usd must be in (0, {MAX_ORDER_USD}]")
        detail = f"market buy {amount} USD of {symbol}"
    else:
        percent = float(payload.get("percent", 100))
        if not 0 < percent <= 100:
            raise HTTPException(400, "percent must be in (0, 100]")
        detail = f"market sell {percent}% of {base_coin(symbol)} ({symbol})"

    if not LIVE_TRADING:
        log.info("DRY-RUN: %s", detail)
        record(action, symbol, detail, "dry-run (no order sent)")
        return JSONResponse({"ok": True, "mode": "dry-run", "would_do": detail})

    try:
        client = get_client()
        if action == "buy":
            result = client.market_buy(symbol, amount)
        else:
            free = client.get_balances().get(base_coin(symbol), 0.0)
            size = free * percent / 100.0
            if size <= 0:
                record(action, symbol, detail, "skipped: zero balance")
                return JSONResponse({"ok": True, "skipped": "zero balance"})
            result = client.market_sell(symbol, size)
        order_id = (result.get("data") or {}).get("orderId", "?")
        record(action, symbol, detail, f"LIVE order placed (id {order_id})")
        return JSONResponse({"ok": True, "mode": "live", "orderId": order_id})
    except PionexError as exc:
        log.error("Order failed: %s", exc)
        record(action, symbol, detail, f"ERROR: {exc}")
        raise HTTPException(502, f"Exchange error: {exc}")


# --- health & dashboard -----------------------------------------------------
@app.get("/health")
async def health() -> dict:
    return {"ok": True, "live_trading": LIVE_TRADING}


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(key: str = "") -> str:
    check_secret(key)
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT ts, action, symbol, detail, status FROM events ORDER BY id DESC LIMIT 50"
        ).fetchall()

    mode = ("<span class='live'>LIVE TRADING</span>" if LIVE_TRADING
            else "<span class='dry'>DRY-RUN (safe)</span>")
    items = "".join(
        f"<li><time>{time.strftime('%b %d %H:%M:%S', time.gmtime(ts))} UTC</time>"
        f"<b>{html.escape(action.upper())} {html.escape(symbol)}</b>"
        f"<span>{html.escape(detail)}</span>"
        f"<em class='{'err' if status.startswith('ERROR') else 'ok'}'>{html.escape(status)}</em></li>"
        for ts, action, symbol, detail, status in rows) or "<li>No signals received yet.</li>"

    return f"""<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webot relay</title><style>
 body {{ font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 1rem;
        background: #0f1419; color: #e6e1d7; }}
 h1 {{ font-size: 1.2rem; }} .live {{ color: #ff6b6b; font-weight: 700; }}
 .dry {{ color: #7bc86c; font-weight: 700; }}
 ul {{ list-style: none; padding: 0; }} li {{ background: #1a2027; border-radius: 10px;
      padding: .7rem .9rem; margin-bottom: .5rem; display: grid; gap: .15rem; }}
 time {{ color: #8a94a3; font-size: .75rem; }} b {{ font-size: .95rem; }}
 li span {{ color: #b8c0cc; font-size: .85rem; }} em {{ font-style: normal; font-size: .8rem; }}
 em.ok {{ color: #7bc86c; }} em.err {{ color: #ff6b6b; }}
</style></head><body>
<h1>Webot relay &middot; {mode}</h1>
<p style="color:#8a94a3;font-size:.85rem">Last 50 signals, newest first. Refresh to update.</p>
<ul>{items}</ul></body></html>"""
