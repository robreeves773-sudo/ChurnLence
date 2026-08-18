"""
SwingStrategy - Novice-friendly crypto swing trading strategy
==============================================================
Designed for: LINK, SOL, XRP, ZBCN on Kraken (4-hour candles)
Mode: START IN DRY-RUN ONLY. Never go live until 30+ days of paper results.

The idea (plain English):
  1. TREND FILTER: Only buy when the 20-period EMA is above the 50-period EMA
     (price is in an uptrend). We never fight the trend.
  2. PULLBACK ENTRY: Within that uptrend, wait for RSI to dip (a pullback)
     and then recover above 45. We buy the dip recovery, not the top.
  3. VOLUME CHECK: Current volume must be above its 20-period average -
     a move without volume is a move we don't trust.
  4. EXITS: Take profit as RSI gets overheated (>70), or bail out if price
     closes below the 50 EMA (trend broke). A hard stop-loss of -8% and a
     trailing stop protect every trade automatically.

This is a conservative, widely-used swing template (EMA trend + RSI pullback).
It is NOT a money printer. It is a disciplined process. Backtest it, paper
trade it, and only then decide anything with real funds.
"""

import talib.abstract as ta
from pandas import DataFrame

import freqtrade.vendor.qtpylib.indicators as qtpylib
from freqtrade.strategy import IStrategy


class SwingStrategy(IStrategy):
    INTERFACE_VERSION = 3

    # --- Core settings -------------------------------------------------
    timeframe = "4h"          # swing trading pace: a few candles per day
    can_short = False          # spot only - we buy and sell, never short
    process_only_new_candles = True
    startup_candle_count = 60  # candles needed before indicators are valid

    # --- Risk management (the important part) --------------------------
    # Hard stop: never lose more than 8% on a single trade.
    stoploss = -0.08

    # Trailing stop: once a trade is up 8%, trail a stop 4% behind price
    # so winners can't turn into losers.
    trailing_stop = True
    trailing_stop_positive = 0.04
    trailing_stop_positive_offset = 0.08
    trailing_only_offset_is_reached = True

    # Time-based profit targets (minutes -> minimum profit to exit).
    # "Take 12%+ any time; after 3 days accept 6%; after 7 days accept 3%."
    minimal_roi = {
        "0": 0.12,
        "4320": 0.06,
        "10080": 0.03,
    }

    # --- Indicators ----------------------------------------------------
    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["vol_avg"] = dataframe["volume"].rolling(20).mean()
        return dataframe

    # --- Buy rules ------------------------------------------------------
    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["ema20"] > dataframe["ema50"])              # uptrend
                & (dataframe["close"] > dataframe["ema50"])            # price healthy
                & (qtpylib.crossed_above(dataframe["rsi"], 45))        # dip recovery
                & (dataframe["volume"] > dataframe["vol_avg"])         # real interest
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    # --- Sell rules -----------------------------------------------------
    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (qtpylib.crossed_above(dataframe["rsi"], 70))          # overheated
                | (qtpylib.crossed_below(dataframe["close"], dataframe["ema50"]))  # trend broke
            ),
            "exit_long",
        ] = 1
        return dataframe
