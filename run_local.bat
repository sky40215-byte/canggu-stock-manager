@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install Node.js, then try again.
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause
