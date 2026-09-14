$ErrorActionPreference = 'Stop'
$flitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $flitRoot 'tools\caddy\caddy.exe'
$config = Join-Path (Split-Path -Parent $PSScriptRoot) 'config\Caddyfile'
$logs = Join-Path $flitRoot 'logs'
$gatewayPidFile = Join-Path $logs 'caddy.pid'
$watcherPidFile = Join-Path $logs 'gateway-watchdog.pid'
$mutex = New-Object Threading.Mutex($false, 'Local\FlitFancyLocalGatewayWatcher')
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    [IO.Directory]::CreateDirectory($logs) | Out-Null
    [IO.File]::WriteAllText($watcherPidFile, [string]$PID)
    $failedHealthChecks = 0
    while ($true) {
        $gateway = $null
        if (Test-Path -LiteralPath $gatewayPidFile) {
            $savedPid = (Get-Content -LiteralPath $gatewayPidFile -Raw).Trim()
            if ($savedPid -match '^\d+$') {
                $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
                if ($candidate -and $candidate.ExecutablePath -eq $exe -and $candidate.CommandLine -like "*$config*") {
                    $gateway = $candidate
                }
            }
        }
        if ($gateway) {
            try {
                # Certificate issuance may still be pending; check the process API,
                # not certificate readiness, to avoid restarting ACME negotiations.
                Invoke-RestMethod 'http://127.0.0.1:2019/config/' -TimeoutSec 3 | Out-Null
                $failedHealthChecks = 0
            } catch { $failedHealthChecks += 1 }
            if ($failedHealthChecks -ge 3) {
                Stop-Process -Id $gateway.ProcessId -ErrorAction SilentlyContinue
                $gateway = $null
            }
        }
        if (-not $gateway) {
            $arguments = 'run --config "' + $config + '" --adapter caddyfile'
            $started = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $flitRoot `
                -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'caddy.out.log') `
                -RedirectStandardError (Join-Path $logs 'caddy.err.log') -PassThru
            [IO.File]::WriteAllText($gatewayPidFile, [string]$started.Id)
            Write-Output ('{0:u} Started local HTTPS gateway PID {1}' -f (Get-Date), $started.Id)
            $failedHealthChecks = 0
        }
        Start-Sleep -Seconds 10
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
