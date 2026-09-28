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
if errorlevel 1 (
    echo Update failed. Check your internet and try again.
    pause
    exit /b 1
)
echo.
echo Starting x_bridge with the new code...
start "x_bridge" "%~dp0x_bridge.bat"
