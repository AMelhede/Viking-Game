@echo off
REM Auto-commit script for Viking Game (Windows batch version)
REM Run this script to enable auto-commit and push on file changes

echo Starting auto-commit watcher for index.html...
echo Press Ctrl+C to stop.

:loop
timeout /t 5 /nobreak >nul
git status --porcelain | findstr /C:"index.html" >nul
if %errorlevel% equ 0 (
    echo Changes detected. Auto-committing and pushing...
    git add index.html
    for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
    set timestamp=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2% %datetime:~8,2%:%datetime:~10,2%:%datetime:~12,2%
    git commit -m "Auto-commit: %timestamp% - Game updates"
    git push origin main
    echo Auto-commit and push completed!
)
goto loop
