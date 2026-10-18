$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '找不到 Node.js。請先安裝 Node.js 18 或更新版本。' -ForegroundColor Red
    Read-Host '按 Enter 關閉'
    exit 1
}
node server.mjs
