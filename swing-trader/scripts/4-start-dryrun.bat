@echo off
cd /d D:\Projects\swing-trader
echo Paper-trading bot starting. Dashboard: http://127.0.0.1:8080
echo Leave this window open. Press Ctrl+C to stop the bot.
freqtrade trade --userdir user_data --config user_data\config.json --strategy SwingStrategy
pause
