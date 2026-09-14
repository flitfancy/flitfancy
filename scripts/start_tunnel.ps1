$ErrorActionPreference = 'Stop'
$flitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$watcher = Join-Path $PSScriptRoot 'watch_tunnel.ps1'
$logs = Join-Path $flitRoot 'logs'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$pidFile = Join-Path $logs 'tunnel-watchdog.pid'
# Clicking Start explicitly resumes a maintenance pause.
Remove-Item -LiteralPath (Join-Path $logs 'tunnel-watchdog.paused') -Force -ErrorAction SilentlyContinue
$mutex = New-Object Threading.Mutex($false, 'Global\FlitFancyTunnelStarter')
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(10000) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another tunnel starter is still running.' }
    if (Test-Path -LiteralPath $pidFile) {
        $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        if ($savedPid -match '^\d+$') {
            $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
            if ($existing -and $existing.CommandLine -match ('-File\s+"' + [regex]::Escape($watcher) + '"')) {
                Write-Output 'Tunnel watchdog already running.'
                exit 0
            }
        }
    }
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $watcher + '"'
    $started = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logs 'tunnel-watchdog.out.log') `
        -RedirectStandardError (Join-Path $logs 'tunnel-watchdog.err.log') -PassThru
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    do {
        if ($started.HasExited) { throw 'Tunnel watchdog exited during startup.' }
        if ((Test-Path -LiteralPath $pidFile) -and
            (Get-Content -LiteralPath $pidFile -Raw).Trim() -eq [string]$started.Id) {
            Write-Output 'Tunnel watchdog started (30 second checks).'
            exit 0
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Tunnel watchdog did not report ready within 10 seconds.'
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
