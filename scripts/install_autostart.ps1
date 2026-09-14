param(
    [string]$Account = ([Security.Principal.WindowsIdentity]::GetCurrent().Name),
    [string]$PythonExe = '',
    [switch]$Remove,
    [switch]$Preview
)
$ErrorActionPreference = 'Stop'
$taskName = 'FlitFancy Autostart'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    exit 0
}
$entry = Join-Path $PSScriptRoot 'start_at_boot.ps1'
if (-not (Test-Path -LiteralPath $PythonExe) -or -not (Test-Path -LiteralPath $entry)) {
    throw 'Startup script or Python is missing.'
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -notlike ('*' + $entry + '*') }).Count) {
    throw 'An unrelated task already uses this name.'
}
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    $entry + '" -PythonExe "' + $PythonExe + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Start FlitFancy backend, sensor listener, local HTTPS gateway and tunnel watchdog 30 seconds after boot. Audio stays on demand. Runs as the existing user without a stored password.'
if ($Preview) { $task; exit 0 }
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-Output 'FlitFancy Autostart registered: at boot, 30 second delay, existing user, limited privileges, no stored password.'
