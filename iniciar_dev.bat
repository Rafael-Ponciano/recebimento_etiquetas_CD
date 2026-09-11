@echo off
cd /d "%~dp0"
if exist "backend\.venv\Scripts\python.exe" (
  "backend\.venv\Scripts\python.exe" iniciar_dev.py
) else (
  python iniciar_dev.py
)
pause
