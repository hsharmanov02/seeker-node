@echo off
REM X bridge launcher — double-click this. Installs what it needs once, then runs.
cd /d "%~dp0"
python -m pip install --quiet playwright
if errorlevel 1 (
    echo Could not install playwright. Make sure Python is installed and on PATH.
    pause
    exit /b 1
)
python x_bridge.py
pause
