@echo off
REM Seeker node one-click updater.
REM Double-click this whenever Scorpio says there's an update.
cd /d "%~dp0"
git pull origin main
echo.
echo Done. If node.py / serve.py were running, restart them to pick up the changes.
pause
