@echo off
REM Launches the Viking Game on http://localhost:8000 and opens it in the default browser.
REM Local server is required because the biosignal SDK needs a secure context (Web Bluetooth, camera).

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Download it from https://nodejs.org and try again.
  pause
  exit /b 1
)

start "" "http://localhost:8000/"
node "%~dp0server.js" 8000
