# Run this script from an Administrator PowerShell terminal.
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open an Administrator PowerShell terminal, then run this script again.'
}
. (Join-Path $PSScriptRoot 'backend_window.ps1')
$state = Get-BackendWindowState
if ($state.Running) {
    if (-not $state.Verified) {
        throw 'Process is not the expected website backend; nothing stopped.'
    }
    Stop-Process -Id $state.ProcessId -Force
}
# The existing watchdog revives the backend; the starter is idempotent.
Start-Process -FilePath $env:ComSpec -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -ArgumentList @('/c', ('""' + (Join-Path $PSScriptRoot 'start_flitfancy.bat') + '" backend"'))
$deadline = [datetime]::UtcNow.AddSeconds(75)
do {
    Start-Sleep -Seconds 2
    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:2671/api/bridge/config' -TimeoutSec 2
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
            Write-Output 'Backend reloaded. Refresh the console and sign in to use the bridge.'
            exit 0
        }
    }
} while ([datetime]::UtcNow -lt $deadline)
throw 'Bridge API did not become ready; check the existing backend watchdog logs.'
