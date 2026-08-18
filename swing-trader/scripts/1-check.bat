@echo off
cd /d D:\Projects\swing-trader
echo === Python ===
python --version || echo PYTHON MISSING - install from python.org
echo === Freqtrade ===
freqtrade --version
echo === Strategy loads? ===
freqtrade list-strategies --userdir user_data
pause
