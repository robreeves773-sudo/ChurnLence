@echo off
REM ============================================================
REM  ChurnLence — Windows one-click launcher
REM  Double-click this file to start the app and open it in your
REM  default browser.  Requires Python 3.9+ (tells you how to get
REM  it if missing).
REM ============================================================
setlocal

cd /d "%~dp0"

REM --- 1) Locate a working Python ------------------------------
set "PYEXE="
where py >nul 2>&1 && set "PYEXE=py -3"
if not defined PYEXE where python >nul 2>&1 && set "PYEXE=python"

if not defined PYEXE (
  echo.
  echo   Python was not found on this PC.
  echo.
  echo   ChurnLence needs Python 3.9 or newer.  To install it:
  echo     1. Open https://www.python.org/downloads/windows/
  echo     2. Click the "Download Python 3.x" button.
  echo     3. Run the installer and CHECK the box
  echo        "Add python.exe to PATH" before clicking Install.
  echo     4. Double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Using Python: %PYEXE%
%PYEXE% --version

REM --- 2) First-run: create .venv + install dependencies -------
if not exist ".venv\Scripts\python.exe" (
  echo.
  echo First run — creating a local Python environment and installing
  echo packages.  This takes about 60 seconds the first time only.
  echo.
  %PYEXE% -m venv .venv
  if errorlevel 1 (
    echo Failed to create virtual environment.  Try running:
    echo     %PYEXE% -m pip install --upgrade pip
    pause
    exit /b 1
  )
)

call ".venv\Scripts\activate.bat"

REM Install / upgrade deps on every run (cheap when up-to-date).
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet
if errorlevel 1 (
  echo Failed to install Python packages.  Check your internet connection.
  pause
  exit /b 1
)

REM --- 3) Start the server, then open the browser --------------
echo.
echo Starting ChurnLence at http://localhost:5000 ...
echo Leave this window open while using the app.
echo Close it when you're done.
echo.

REM Open the browser after a short delay so Flask is listening.
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:5000"

REM Optional: pass DEMO=1 on the command line to run without internet.
if /i "%1"=="DEMO" set CHURNLENCE_DEMO=1

python app.py

echo.
echo ChurnLence has stopped.
pause
