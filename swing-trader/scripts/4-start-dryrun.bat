@echo off
cd /d D:\Projects\swing-trader
python scripts\make_private_config.py
echo Paper-trading bot starting.
echo   FreqUI (charts):     http://127.0.0.1:8080
echo   Swing Deck (sounds): double-click 5-dashboard.bat
echo Leave this window open. Press Ctrl+C to stop the bot.
freqtrade trade --userdir user_data --config user_data\config.json --config user_data\config-private.json --strategy SwingStrategy
pause
