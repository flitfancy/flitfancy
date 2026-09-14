param(
    [string]$Exe = '',
    [string]$Config = '',
    [string]$WorkDir = '',
    [string]$Logs = ''
)

$ErrorActionPreference = 'Stop'
if (-not $WorkDir) { $WorkDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not $Exe) { $Exe = Join-Path $WorkDir 'tools\cloudflared\cloudflared.exe' }
if (-not $Config) { $Config = Join-Path $env:USERPROFILE '.cloudflared\config.yml' }
if (-not $Logs) { $Logs = Join-Path $WorkDir 'logs' }
$tunnelPidFile = Join-Path $Logs 'cloudflared.pid'
$watcherPidFile = Join-Path $Logs 'tunnel-watchdog.pid'
$pauseFile = Join-Path $Logs 'tunnel-watchdog.paused'

function Test-TunnelIdentity($Candidate) {
    # Do not trust a PID file: Windows may reuse the PID for an unrelated process.
    $configArgument = '(?i)(?:^|\s)--config\s+(?:"' + [regex]::Escape($Config) + '"|' +
        [regex]::Escape($Config) + '(?=\s|$))'
    return $Candidate -and $Candidate.ExecutablePath -eq $Exe -and
        $Candidate.CommandLine -match $configArgument -and
        $Candidate.CommandLine -match '(?:^|\s)tunnel(?:\s+--metrics\s+(?:"[^"]+"|\S+))?\s+run(?:\s|$)'
}

function Get-WatchedTunnel {
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { Test-TunnelIdentity $_ })
    if ($candidates.Count -gt 1) { throw 'Multiple matching tunnels; refusing to choose a process.' }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return $null
}

function Test-TunnelReady($Tunnel) {
    # Discover only this process's loopback metrics listener, including adopted tunnels.
    $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $Tunnel.ProcessId -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    foreach ($listener in $listeners) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri (
                'http://127.0.0.1:{0}/ready' -f $listener.LocalPort)
            if ($response.StatusCode -eq 200) { return $true }
        } catch { }
    }
    return $false
}

function Restart-WatchedTunnel($Tunnel) {
    if ($Tunnel) {
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $Tunnel.ProcessId)
        if ($current) {
            if (-not (Test-TunnelIdentity $current) -or $current.CreationDate -ne $Tunnel.CreationDate) {
                throw 'Process identity changed; refusing to stop it.'
            }
            Stop-Process -Id $current.ProcessId -Force
            Wait-Process -Id $current.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    # Let cloudflared choose a free metrics port, bound only to this computer.
    $arguments = '--config "' + $Config + '" tunnel --metrics 127.0.0.1:0 run'
    $started = Start-Process -FilePath $Exe -ArgumentList $arguments -WorkingDirectory $WorkDir `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'cloudflared.out.log') `
        -RedirectStandardError (Join-Path $Logs 'cloudflared.err.log') -PassThru
    [IO.File]::WriteAllText($tunnelPidFile, [string]$started.Id)
    Write-Output ('{0:u} Started tunnel PID {1}' -f (Get-Date), $started.Id)
}

function Invoke-TunnelWatchCycle($State, [datetime]$Now) {
    if (Test-Path -LiteralPath $pauseFile) { return }
    $tunnel = Get-WatchedTunnel
    if ($tunnel -and $State.LastProcessId -ne $tunnel.ProcessId) {
        $State.LastProcessId = $tunnel.ProcessId
        $State.GraceUntil = $Now.AddSeconds(60)
        $State.Failures = 0
        $State.HealthyChecks = 0
        [IO.File]::WriteAllText($tunnelPidFile, [string]$tunnel.ProcessId)
        Write-Output ('{0:u} Watching tunnel PID {1}' -f $Now, $tunnel.ProcessId)
    }
    if ($tunnel) {
        if (Test-TunnelReady $tunnel) {
            if ($State.Failures -gt 0) { Write-Output ('{0:u} Tunnel connection recovered' -f $Now) }
            $State.Failures = 0
            $State.HealthyChecks += 1
            if ($State.HealthyChecks -ge 3) {
                $State.Backoff = 5
                $State.NextStart = [datetime]::MinValue
            }
            return
        }
        $State.HealthyChecks = 0
        if ($Now -lt $State.GraceUntil) { return }
        $State.Failures += 1
        if ($State.Failures -lt 3) { return }
    }
    if ($Now -lt $State.NextStart) { return }
    # Reserve the cooldown before starting, so launch failures also back off.
    $State.NextStart = $Now.AddSeconds($State.Backoff)
    $State.Backoff = [math]::Min(300, $State.Backoff * 2)
    $State.Failures = 0
    $State.LastProcessId = 0
    Write-Output ('{0:u} Recovering tunnel ({1})' -f $Now, $(if ($tunnel) { 'not ready' } else { 'process exited' }))
    Restart-WatchedTunnel $tunnel
}

function Start-TunnelWatch {
    if (-not (Test-Path -LiteralPath $Exe) -or -not (Test-Path -LiteralPath $Config)) {
        throw 'Tunnel executable or configuration is missing.'
    }
    [IO.Directory]::CreateDirectory($Logs) | Out-Null
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant()))).Replace('-', '') }
    finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Global\FlitFancyTunnelWatcher-' + $key))
    $ownsMutex = $false
    try {
        try { $ownsMutex = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { return }
        [IO.File]::WriteAllText($watcherPidFile, [string]$PID)
        $state = @{ LastProcessId = 0; Failures = 0; HealthyChecks = 0; Backoff = 5;
            NextStart = [datetime]::MinValue; GraceUntil = [datetime]::MinValue }
        while ($true) {
            try { Invoke-TunnelWatchCycle $state ([datetime]::UtcNow) }
            catch { Write-Output ('{0:u} Watch check failed ({1}); retrying later' -f (Get-Date), $_.Exception.GetType().Name) }
            Start-Sleep -Seconds 30
        }
    } finally {
        if ($ownsMutex) {
            Remove-Item -LiteralPath $watcherPidFile -Force -ErrorAction SilentlyContinue
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') { Start-TunnelWatch }
