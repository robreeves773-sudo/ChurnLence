@echo off
cd /d D:\Projects\swing-trader
freqtrade backtesting --userdir user_data --config user_data\config.json --strategy SwingStrategy --timeframe 4h
pause
