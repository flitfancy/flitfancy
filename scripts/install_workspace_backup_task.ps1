param(
    [Parameter(Mandatory = $true)][string]$Config,
    [string]$TaskName = 'FlitFancy Workspace Backup',
    [datetime]$At = '04:00',
    [switch]$Preview
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$scriptPath = Join-Path $PSScriptRoot 'workspace_backup.py'
$python = (Get-Command py.exe -ErrorAction Stop).Source
$arguments = '-3.14 "' + $scriptPath + '" create --config "' + $configPath + '"'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -notlike ('*' + $scriptPath + '*') }).Count) {
    throw 'An unrelated task already uses this name.'
}
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Create and verify a private workspace snapshot containing source history, handoffs, sensor CSV, online SQLite backup and local configuration.'
if ($Preview) { $task; exit 0 }
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Output 'FlitFancy Workspace Backup registered: daily 04:00, catch up after login, existing user, limited privileges.'
