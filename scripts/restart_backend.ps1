# Restart only the verified local FlitFancy backend; its existing watchdog owns startup.
$ErrorActionPreference = 'Stop'
$logsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'logs'
$backendId = [int](Get-Content -LiteralPath (Join-Path $logsRoot 'backend.pid') -Raw)
$watchdogId = [int](Get-Content -LiteralPath (Join-Path $logsRoot 'backend-watchdog.pid') -Raw)
$owner = Get-NetTCPConnection -LocalPort 2671 -State Listen | Select-Object -First 1
$status = Invoke-RestMethod 'http://127.0.0.1:2671/api/status' -TimeoutSec 5
if ($owner.OwningProcess -ne $backendId -or $status.name -ne 'flitfancy') {
    throw 'Port 2671 does not match the registered FlitFancy backend.'
}
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$backendId"
$watchdog = Get-CimInstance Win32_Process -Filter "ProcessId=$watchdogId"
if ($process.CommandLine -notmatch 'server\.py' -or $watchdog.CommandLine -notmatch 'watch_backend\.ps1') {
    throw 'Cannot verify backend/watchdog identity. Run this script in an Administrator PowerShell window.'
}
Stop-Process -Id $backendId -ErrorAction Stop
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
        $current = Invoke-RestMethod 'http://127.0.0.1:2671/api/status' -TimeoutSec 2
        if ($current.name -eq 'flitfancy') {
            Write-Host 'FlitFancy backend restarted. Refresh the console page.'
            exit 0
        }
    } catch { }
}
throw 'Backend did not return within 60 seconds. Check logs/backend-watchdog.err.log.'
