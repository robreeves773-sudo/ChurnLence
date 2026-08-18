"""
quick_data.py - Fast Kraken data fetcher for backtesting
=========================================================
Kraken's public API only serves the most recent 720 candles per timeframe,
and Freqtrade's normal downloader insists on a very slow trade-by-trade
download for Kraken. This script grabs those 720 candles directly (120 days
of 4h data) and saves them in Freqtrade's format - enough for a solid
rolling backtest in seconds instead of hours.

Usage (from the swing-trader folder):
    python scripts/quick_data.py
"""

import time
from pathlib import Path

import pandas as pd
import requests

PAIRS = {
    "LINK/USD": "LINKUSD",
    "SOL/USD": "SOLUSD",
    "XRP/USD": "XRPUSD",
    "ZBCN/USD": "ZBCNUSD",
}
TIMEFRAME = "4h"
INTERVAL_MIN = 240  # 4h in minutes

DATA_DIR = Path(__file__).resolve().parent.parent / "user_data" / "data" / "kraken"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def fetch_pair(freq_pair: str, kraken_pair: str) -> None:
    url = "https://api.kraken.com/0/public/OHLC"
    resp = requests.get(url, params={"pair": kraken_pair, "interval": INTERVAL_MIN}, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("error"):
        raise RuntimeError(f"Kraken error for {kraken_pair}: {payload['error']}")

    # Result dict has one key (the pair name Kraken uses) plus 'last'
    key = next(k for k in payload["result"] if k != "last")
    rows = payload["result"][key]

    df = pd.DataFrame(
        rows,
        columns=["time", "open", "high", "low", "close", "vwap", "volume", "count"],
    )
    df["date"] = pd.to_datetime(df["time"], unit="s", utc=True)
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = df[col].astype(float)
    df = df[["date", "open", "high", "low", "close", "volume"]]
    # Drop the final (still-forming) candle
    df = df.iloc[:-1].reset_index(drop=True)

    out = DATA_DIR / f"{freq_pair.replace('/', '_')}-{TIMEFRAME}.feather"
    df.to_feather(out)
    span = (df["date"].iloc[-1] - df["date"].iloc[0]).days
    print(f"  {freq_pair}: {len(df)} candles ({span} days) -> {out.name}")


def main() -> None:
    print(f"Fetching {TIMEFRAME} candles from Kraken into {DATA_DIR} ...")
    for freq_pair, kraken_pair in PAIRS.items():
        try:
            fetch_pair(freq_pair, kraken_pair)
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"  {freq_pair}: FAILED - {exc}")
        time.sleep(1.2)  # be polite to Kraken's rate limits
    print("Done. You can now run a backtest.")


if __name__ == "__main__":
    main()
