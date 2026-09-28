$ErrorActionPreference = 'Stop'
$flitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$watcher = Join-Path $PSScriptRoot 'watch_tunnel.ps1'
$logs = Join-Path $flitRoot 'logs'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$pidFile = Join-Path $logs 'tunnel-watchdog.pid'
function Test-ExistingTunnelWatcher {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
    $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($savedPid -notmatch '^\d+$') { return $false }
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
    if (-not $existing -or $existing.Name -notmatch '^(powershell|pwsh)\.exe$') { return $false }
    if (-not $existing.CommandLine) {
        # An elevated watcher is invisible to a normal browser-launched window.
        # Do not launch a duplicate into its protected singleton mutex.
        Write-Host 'Registered tunnel watcher is running with restricted identity access; leaving it unchanged. Use the local restart menu if needed.'
        return $true
    }
    $fileArgument = '(?i)(?:^|\s)-File\s+(?:"' + [regex]::Escape($watcher) + '"|' + [regex]::Escape($watcher) + ')(?=\s|$)'
    if ($existing.CommandLine -match $fileArgument) {
        Write-Host 'Tunnel watchdog already running.'
        return $true
    }
    return $false
}
# Clicking Start explicitly resumes a maintenance pause.
Remove-Item -LiteralPath (Join-Path $logs 'tunnel-watchdog.paused') -Force -ErrorAction SilentlyContinue
if (Test-ExistingTunnelWatcher) { exit 0 }
$mutex = New-Object Threading.Mutex($false, 'Global\FlitFancyTunnelStarter')
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(10000) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another tunnel starter is still running.' }
    if (Test-ExistingTunnelWatcher) { exit 0 }
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $watcher + '"'
    $started = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logs 'tunnel-watchdog.out.log') `
        -RedirectStandardError (Join-Path $logs 'tunnel-watchdog.err.log') -PassThru
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    do {
        $started.Refresh()
        if ($started.HasExited) {
            if (Test-ExistingTunnelWatcher) { exit 0 }
            throw 'Tunnel watchdog exited during startup. Check logs/tunnel-watchdog.err.log.'
        }
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
