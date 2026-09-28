@echo off
REM Seeker node one-click updater.
REM Double-click this whenever Scorpio says there's an update.
cd /d "%~dp0"

REM Stop any running x_bridge (it serves on port 8898) so you don't
REM have to Ctrl+C it yourself. Its Chrome window is left alone and
REM the new bridge reconnects to it on start.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8898" ^| findstr "LISTENING"') do (
    echo Stopping x_bridge (PID %%a)...
    taskkill /PID %%a /F >nul 2>nul
)

git pull origin main
echo.
echo Done. If node.py / serve.py were running, restart them to pick up the changes.
echo Now re-run x_bridge.bat to start the bridge with the new code.
pause
