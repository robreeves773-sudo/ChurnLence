"""Minimal Webot/Pionex REST API client.

Implements the signing scheme from the public Pionex API docs
(https://www.pionex.com/docs/api-docs). Webot is the former Pionex.US;
verify which base URL your account's API keys belong to (see README)
and confirm auth works with check_setup.py before enabling live trading.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import httpx


class PionexError(RuntimeError):
    pass


class PionexClient:
    def __init__(self, api_key: str, api_secret: str,
                 base_url: str = "https://api.pionex.com", timeout: float = 10.0):
        self.api_key = api_key
        self.api_secret = api_secret.encode()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # --- signing -----------------------------------------------------------
    def _signed_request(self, method: str, path: str,
                        params: dict | None = None, body: dict | None = None) -> dict:
        params = dict(params or {})
        params["timestamp"] = str(int(time.time() * 1000))
        query = urlencode(sorted(params.items()))
        path_url = f"{path}?{query}"

        payload = method.upper() + path_url
        body_str = ""
        if body is not None:
            body_str = json.dumps(body, separators=(",", ":"))
            payload += body_str

        signature = hmac.new(self.api_secret, payload.encode(), hashlib.sha256).hexdigest()
        headers = {
            "PIONEX-KEY": self.api_key,
            "PIONEX-SIGNATURE": signature,
            "Content-Type": "application/json",
        }

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.request(method.upper(), self.base_url + path_url,
                                  headers=headers,
                                  content=body_str if body is not None else None)
        try:
            data = resp.json()
        except ValueError as exc:
            raise PionexError(f"non-JSON response ({resp.status_code}): {resp.text[:300]}") from exc
        if resp.status_code != 200 or not data.get("result", True):
            raise PionexError(f"API error {resp.status_code}: {data}")
        return data

    # --- endpoints ---------------------------------------------------------
    def get_balances(self) -> dict[str, float]:
        """Return free balance per coin, e.g. {"USDT": 103.2, "BTC": 0.001}."""
        data = self._signed_request("GET", "/api/v1/account/balances")
        balances = (data.get("data") or {}).get("balances") or []
        return {b["coin"]: float(b.get("free", 0)) for b in balances}

    def market_buy(self, symbol: str, quote_amount: float) -> dict:
        """Market-buy `symbol` spending `quote_amount` of the quote currency (e.g. USDT)."""
        body = {"symbol": symbol, "side": "BUY", "type": "MARKET",
                "amount": f"{quote_amount:.8f}".rstrip("0").rstrip(".")}
        return self._signed_request("POST", "/api/v1/trade/order", body=body)

    def market_sell(self, symbol: str, base_size: float) -> dict:
        """Market-sell `base_size` units of the base currency of `symbol`."""
        body = {"symbol": symbol, "side": "SELL", "type": "MARKET",
                "size": f"{base_size:.8f}".rstrip("0").rstrip(".")}
        return self._signed_request("POST", "/api/v1/trade/order", body=body)


QUOTE_CURRENCIES = ("USDT", "USDC", "USD", "BTC", "ETH")


def normalize_symbol(raw: str) -> str:
    """Map TradingView tickers like 'BTCUSDT' or 'BTCUSD' to Pionex 'BTC_USDT'."""
    s = raw.upper().strip().replace("-", "_").replace("/", "_")
    if "_" in s:
        return s
    for quote in QUOTE_CURRENCIES:
        if s.endswith(quote) and len(s) > len(quote):
            return f"{s[:-len(quote)]}_{quote}"
    return s


def base_coin(symbol: str) -> str:
    return symbol.split("_")[0]
