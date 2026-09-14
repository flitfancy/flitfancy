param([Parameter(Mandatory = $true)][string]$PythonExe)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logs = Join-Path $root 'logs'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$reportPath = Join-Path $logs 'autostart-result.json'
$report = @{ StartedAt = [datetime]::UtcNow.ToString('o'); User = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
    SessionId = (Get-Process -Id $PID).SessionId; Success = $false }
try {
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { throw 'Configured Python is unavailable.' }
    # S4U uses this user's local files without storing a Windows password.
    $config = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
    $configText = [IO.File]::ReadAllText($config)
    $credentialMatch = [regex]::Match($configText, '(?m)^credentials-file:\s*(.+?)\s*$')
    if (-not $credentialMatch.Success) { throw 'Tunnel credential path not found.' }
    $credentialPath = $credentialMatch.Groups[1].Value.Trim().Trim('"').Trim("'")
    $credentialStream = [IO.File]::OpenRead($credentialPath)
    $credentialStream.Dispose()
    $report.CredentialsReadable = $true
    $env:FLITFANCY_PYTHON = $PythonExe
    & $PythonExe --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Configured Python did not run.' }
    $report.PythonReady = $true

    # PID numbers from a previous boot may now belong to unrelated programs.
    $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
    foreach ($name in @('backend-watchdog.pid', 'backend.pid', 'sensor-watchdog.pid',
        'gateway-watchdog.pid', 'caddy.pid', 'tunnel-watchdog.pid', 'cloudflared.pid')) {
        $file = Get-Item -LiteralPath (Join-Path $logs $name) -ErrorAction SilentlyContinue
        if ($file -and $file.LastWriteTimeUtc -lt $bootTime) { Remove-Item -LiteralPath $file.FullName -Force }
    }
    Push-Location $PSScriptRoot
    try {
        & cmd.exe /c call start_flitfancy.bat all *> (Join-Path $logs 'autostart.log')
        if ($LASTEXITCODE -ne 0) { throw 'Service launcher returned an error.' }
    } finally { Pop-Location }
    $deadline = [datetime]::UtcNow.AddSeconds(60)
    do {
        $backendReady = $false
        try {
            Invoke-RestMethod http://127.0.0.1:2671/api/status -TimeoutSec 3 | Out-Null
            $backendReady = $true
        } catch { }
        $ports = @(Get-NetTCPConnection -State Listen -LocalPort 443,7777 -ErrorAction SilentlyContinue)
        $watcherReady = $false
        $watcherFile = Join-Path $logs 'tunnel-watchdog.pid'
        if (Test-Path -LiteralPath $watcherFile) {
            $watcherId = (Get-Content -LiteralPath $watcherFile -Raw).Trim()
            if ($watcherId -match '^\d+$') {
                $watcher = Get-CimInstance Win32_Process -Filter "ProcessId=$watcherId"
                $watcherReady = $watcher -and $watcher.CommandLine -like '*\scripts\watch_tunnel.ps1*'
            }
        }
        if ($backendReady -and 443 -in $ports.LocalPort -and 7777 -in $ports.LocalPort -and $watcherReady) {
            $report.Success = $true
            break
        }
        Start-Sleep -Seconds 3
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $report.Success) { throw 'Services did not become ready; Task Scheduler will retry.' }
    # Verify outbound HTTPS in the scheduled logon context without transmitting local data.
    # A WAN outage must not stop the local watchdogs from starting.
    try {
        $networkCheck = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'https://www.cloudflare.com/cdn-cgi/trace'
        $report.OutboundHttpsReady = $networkCheck.StatusCode -eq 200
    } catch { $report.OutboundHttpsReady = $false }
} catch {
    # Never include credential contents, command output or arbitrary API data.
    $report.ErrorType = $_.Exception.GetType().Name
} finally {
    $report.FinishedAt = [datetime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
}
if (-not $report.Success) { exit 1 }
