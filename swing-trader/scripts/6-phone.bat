@echo off
cd /d D:\Projects\swing-trader
python scripts\make_private_config.py
echo (Your login password is in user_data\config-private.json)
echo.
echo Type the "On your PHONE" address below into your phone's browser.
echo Tip: in the browser menu choose "Add to Home Screen" and Swing Deck
echo becomes an app icon on your phone.
echo.
python scripts\serve_deck.py --lan
