@echo off
cd /d D:\Projects\swing-trader
python scripts\make_private_config.py
echo Swing Deck starting at http://127.0.0.1:8082
echo (Your login password is in user_data\config-private.json)
echo Leave this window open while you use the dashboard.
start "" http://127.0.0.1:8082
python -m http.server 8082 --bind 127.0.0.1 --directory dashboard
