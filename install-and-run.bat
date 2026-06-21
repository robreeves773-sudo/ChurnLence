@echo off
REM ============================================================
REM  ChurnLence — Zero-config Windows installer
REM
REM  Double-click this file. It will:
REM    1. Detect or auto-install Python 3.12 (silent, no admin)
REM    2. Set up a private virtual environment
REM    3. Install the dependencies
REM    4. Start the app and open your browser
REM
REM  Use this if you don't want to deal with downloading Python
REM  yourself. Otherwise see run-windows.bat.
REM ============================================================
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "PY_VER=3.12.7"
set "PY_FILE=python-%PY_VER%-amd64.exe"
set "PY_URL=https://www.python.org/ftp/python/%PY_VER%/%PY_FILE%"
set "PY_INSTALL_DIR=%LOCALAPPDATA%\Programs\Python\Python312"

REM --- 1) Find Python ----------------------------------------
set "PYEXE="
where py  >nul 2>&1 && set "PYEXE=py -3"
if not defined PYEXE where python >nul 2>&1 && set "PYEXE=python"
if not defined PYEXE if exist "%PY_INSTALL_DIR%\python.exe" set "PYEXE=%PY_INSTALL_DIR%\python.exe"

if not defined PYEXE (
  echo.
  echo Python is not installed.  Downloading the official installer
  echo from python.org now.  No admin rights are required — Python
  echo will be installed for your user only.
  echo.

  REM Use PowerShell to download the installer (TLS 1.2, progress).
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "Invoke-WebRequest -Uri '%PY_URL%' -OutFile '%TEMP%\%PY_FILE%' -UseBasicParsing"
  if errorlevel 1 (
    echo.
    echo Download failed.  Check your internet connection and try again.
    pause
    exit /b 1
  )

  echo Installing Python (silent, ~30 sec)...
  REM /quiet  → no UI ; InstallAllUsers=0 → per-user, no admin ; PrependPath=1 → adds to PATH
  "%TEMP%\%PY_FILE%" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1 SimpleInstall=1
  if errorlevel 1 (
    echo Python install failed.  See https://www.python.org/downloads/windows/
    pause
    exit /b 1
  )
  del "%TEMP%\%PY_FILE%" 2>nul

  REM Refresh PATH for this session by checking the standard install path.
  if exist "%PY_INSTALL_DIR%\python.exe" (
    set "PYEXE=%PY_INSTALL_DIR%\python.exe"
  ) else (
    echo Python installed but not found at %PY_INSTALL_DIR%.
    echo Please open a new terminal and re-run this file.
    pause
    exit /b 1
  )
)

echo Using Python: %PYEXE%
%PYEXE% --version

REM --- 2) Create a venv on first run -------------------------
if not exist ".venv\Scripts\python.exe" (
  echo Setting up a private Python environment...
  %PYEXE% -m venv .venv
  if errorlevel 1 (
    echo Could not create the virtual environment.
    pause
    exit /b 1
  )
)

call ".venv\Scripts\activate.bat"

echo Installing required packages (first run only takes ~60 sec)...
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet
if errorlevel 1 (
  echo Package install failed.  Try again on a less restrictive network.
  pause
  exit /b 1
)

REM --- 3) Run the server, open the browser -------------------
echo.
echo  ===========================================================
echo   ChurnLence is starting at http://localhost:5000
echo   Leave this window open while using the app.
echo   Close it when you're done.
echo  ===========================================================
echo.

set CHURNLENCE_OPEN_BROWSER=1
if /i "%1"=="DEMO" set CHURNLENCE_DEMO=1

python app.py

echo.
echo ChurnLence has stopped.
pause
