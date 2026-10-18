$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '找不到 Node.js。請先安裝 Node.js 18 或更新版本。' -ForegroundColor Red
    Read-Host '按 Enter 關閉'
    exit 1
}
$listener = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    try {
        $config = Invoke-RestMethod -Uri 'http://127.0.0.1:4174/api/sync/config' -TimeoutSec 3
        if ($config.PSObject.Properties.Name -contains 'configured' -and $config.PSObject.Properties.Name -contains 'production') {
            Write-Host '股票管理系統已在執行，正在開啟現有網頁。' -ForegroundColor Green
            Start-Process 'http://127.0.0.1:4174'
            exit 0
        }
    } catch { }
    Write-Host '連接埠 4174 已被其他程式使用。請關閉該程式，或使用它目前提供的網站。' -ForegroundColor Red
    Read-Host '按 Enter 關閉'
    exit 2
}
node server.mjs
