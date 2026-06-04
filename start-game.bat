@echo off
title Valhalla
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM Valhalla launcher. Serves the game on http://localhost:8055/ (a local
REM server is required: the biosignal SDK needs a secure context for Web
REM Bluetooth + camera). The window is kept OPEN on exit so any error is
REM readable instead of flashing closed.
REM
REM *** DO NOT CHANGE THE PORT (8055). ***  localStorage (your scores,
REM streak, badges, custom name) is keyed PER ORIGIN, i.e. per port. Every
REM port change wipes all saved progress because the browser treats it as a
REM brand-new site. 8055 is permanent.
REM ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Download it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

REM Force-sync to the latest pushed code. The previous "git pull --ff-only"
REM failed SILENTLY whenever the working tree looked dirty (Windows line-ending
REM churn), which left old code running and was the real cause of "my fixes
REM never show up". This folder is run-only (you don't edit code here), so a
REM hard reset to origin/main is safe and guarantees you get the latest build.
where git >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Updating Valhalla to the latest build...
  git fetch origin
  git reset --hard origin/main
  echo Done. Now on commit:
  git rev-parse --short HEAD
)

echo.
echo ===========================================================
echo  Starting Valhalla server on  http://localhost:8055/
echo  Leave this window open while you play. Close it to stop.
echo ===========================================================
echo.
start "" "http://localhost:8055/"
node "%~dp0server.js" 8055

echo.
echo The server stopped. If there is an error message above, copy it to Claude.
pause
