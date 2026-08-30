<#
Install or update the daily FlitFancy SQLite backup task for the current user.

The task runs only when the user is logged on. StartWhenAvailable makes Windows
run a missed 03:30 backup after the next sign-in or wake-up.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'FlitFancy SQLite Backup',
  [string]$Destination = 'B:\FlitFancy\data',
  [ValidateRange(1, 365)][int]$Keep = 14,
  [datetime]$At = '03:30'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$root = Split-Path -Parent $PSScriptRoot
$backupScript = Join-Path $PSScriptRoot 'backup_sqlite.py'
$source = Join-Path $root 'backend\data\flitfancy.db'

if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
  throw "Backup script not found: $backupScript"
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "SQLite database not found: $source"
}

$pythonLauncher = (Get-Command py.exe -ErrorAction Stop).Source
$arguments = '-3.14 "{0}" --source "{1}" --destination "{2}" --keep {3}' -f `
  $backupScript, $source, $Destination, $Keep
$action = New-ScheduledTaskAction `
  -Execute $pythonLauncher `
  -Argument $arguments `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 10) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal `
  -UserId $identity `
  -LogonType Interactive `
  -RunLevel Limited
$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Create a verified SQLite backup and retain the latest $Keep copies."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
$registered = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host ('Task installed: {0}' -f $registered.TaskName)
Write-Host ('Next run: {0}' -f $info.NextRunTime)
Write-Host ('Backup directory: {0}' -f (Join-Path $Destination 'daily'))
Write-Host ('Manual run: py -3.14 "{0}"' -f $backupScript)
