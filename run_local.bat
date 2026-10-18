@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install Node.js, then try again.
  pause
  exit /b 1
)
powershell -NoProfile -Command "$listener = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $listener) { exit 1 }; try { $config = Invoke-RestMethod -Uri 'http://127.0.0.1:4174/api/sync/config' -TimeoutSec 3; if ($config.PSObject.Properties.Name -contains 'configured' -and $config.PSObject.Properties.Name -contains 'production') { Start-Process 'http://127.0.0.1:4174'; exit 0 } } catch {}; Write-Host 'Port 4174 is occupied by another program. Close that program or use the website it is already serving.'; exit 2"
if errorlevel 2 (
  pause
  exit /b 2
)
if not errorlevel 1 exit /b 0
node server.mjs
if errorlevel 1 pause
