$ErrorActionPreference = 'Stop'
$flitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$watcher = Join-Path $PSScriptRoot 'watch_local_gateway.ps1'
$exe = Join-Path $flitRoot 'tools\caddy\caddy.exe'
if (-not (Test-Path -LiteralPath $exe)) { exit 0 }
$logs = Join-Path $flitRoot 'logs'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$pidFile = Join-Path $logs 'gateway-watchdog.pid'
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($savedPid -match '^\d+$') {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
        if ($existing -and $existing.CommandLine -like "*$watcher*") { exit 0 }
    }
}
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $watcher + '"'
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'gateway-watchdog.out.log') `
    -RedirectStandardError (Join-Path $logs 'gateway-watchdog.err.log') | Out-Null
