@echo off
cd /d D:\Projects\swing-trader
python scripts\make_private_config.py
echo (Your login password is in user_data\config-private.json)
start "" http://127.0.0.1:8082
python scripts\serve_deck.py
