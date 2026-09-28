param([Parameter(Mandatory=$true)][ValidateSet('listener', 'audio', 'tunnel')][string]$Service)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service_control.ps1')
$logRoot = (Get-LocalServiceSpec $Service).Logs
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$log = Join-Path $logRoot 'service-restart.log'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Open this helper in an Administrator terminal.' }
    Add-Content -LiteralPath $log -Encoding UTF8 -Value ('{0:u} {1}: restart controller started (PID {2})' -f (Get-Date), $Service, $PID)
    foreach ($oldController in @(Clear-StaleServiceControllers $Service)) {
        Add-Content -LiteralPath $log -Encoding UTF8 -Value ('{0:u} {1}: retired stale restart controller PID {2}' -f (Get-Date), $Service, $oldController)
    }
    Invoke-LocalServiceOperation -Service $Service -Restart
    Add-Content -LiteralPath $log -Encoding UTF8 -Value ('{0:u} {1}: restarted and ready' -f (Get-Date), $Service)
    exit 0
} catch {
    # No command line, configuration body or credentials go into this log.
    $known = @('Service process cannot be verified; nothing was stopped.',
        'Service identity changed during restart; no further processes stopped.',
        'Service identity changed; refusing to stop this process.', 'Service did not stop in time.',
        'Existing service identity is unavailable or ambiguous; nothing was stopped or started.',
        'Service starter failed. See logs/starter.log.',
        'Service has not become ready. Its process may still be starting; see logs/starter.log.',
        'Another service operation is still running.', 'Invalid service PID record; no process was changed.')
    $reason = if ($known -contains $_.Exception.Message) { $_.Exception.Message } else { $_.Exception.GetType().Name }
    Add-Content -LiteralPath $log -Encoding UTF8 -Value ('{0:u} {1}: restart failed: {2}' -f (Get-Date), $Service, $reason)
    exit 1
}
