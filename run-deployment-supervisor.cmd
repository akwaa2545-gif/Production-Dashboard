@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required.
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git is required so this computer can receive dashboard updates.
  exit /b 1
)

if not exist ".env" (
  echo Missing .env configuration file.
  exit /b 1
)

set HOST=0.0.0.0
set PORT=5000
call node scripts\dashboard-supervisor.mjs
