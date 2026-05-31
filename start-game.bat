@echo off
REM Launches the Viking Game on http://localhost:8042 and opens it in the default browser.
REM Local server is required because the biosignal SDK needs a secure context (Web Bluetooth, camera).
REM
REM PORT CHANGED 8000 -> 8042 ON PURPOSE: localhost:8042 is a brand-new
REM origin your browser has never seen, so it has ZERO cached files and
REM ZERO service worker. This permanently sidesteps the stale-cache
REM problem where old builds kept being served from a service worker no
REM server header could override.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Download it from https://nodejs.org and try again.
  pause
  exit /b 1
)

REM Auto-pull latest code from GitHub before serving.
where git >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Checking for latest Valhalla updates...
  pushd "%~dp0"
  git fetch origin --quiet 2>nul
  git pull --ff-only origin main --quiet 2>nul
  popd
)

start "" "http://localhost:8042/"
node "%~dp0server.js" 8042
