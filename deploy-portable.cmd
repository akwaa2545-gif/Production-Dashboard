@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it, then run this command again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js 20 or later, then run this command again.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Missing .env configuration file.
  echo Copy .env.example to .env and configure the server before deployment.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo Installing production dependencies...
  call npm ci --omit=dev
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

set HOST=0.0.0.0
set PORT=5000
echo Starting OneMES dashboard on port %PORT%...
echo Open http://localhost:%PORT% on this machine or http://SERVER-IP:%PORT% from the LAN.
call npm start
echo Dashboard process stopped with exit code %errorlevel%.
pause
