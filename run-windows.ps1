# ChurnLence Windows launcher (PowerShell edition).
# Run with:  powershell -ExecutionPolicy Bypass -File run-windows.ps1
# Or allow script execution once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Have-Cmd([string]$cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

if (Have-Cmd 'py')     { $python = 'py -3' }
elseif (Have-Cmd 'python') { $python = 'python' }
else {
  Write-Host "`n  Python is not installed.`n  Download it from https://www.python.org/downloads/windows/`n  Check 'Add python.exe to PATH' during install, then run this script again.`n"
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host "Using: $python"
& $python.Split()[0] $python.Split()[1..($python.Split().Length-1)] --version

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "`nFirst run — creating a local Python environment (one-time, ~60 sec)..."
  & $python.Split()[0] $python.Split()[1..($python.Split().Length-1)] -m venv .venv
}

& ".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
& ".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet

Write-Host "`nStarting ChurnLence at http://localhost:5000"
Write-Host "Leave this window open; close it to stop the app.`n"

Start-Job -ScriptBlock {
  Start-Sleep -Seconds 2
  Start-Process "http://localhost:5000"
} | Out-Null

if ($args -contains 'demo') { $env:CHURNLENCE_DEMO = '1' }
& ".venv\Scripts\python.exe" app.py
