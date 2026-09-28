$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\service_window.ps1')
function Assert-Equal($Actual, $Expected, $Message) {
    if ($Actual -ne $Expected) { throw "$Message (expected $Expected, got $Actual)" }
}

# Validate the real identity rules with fixtures, including the legacy audio entry.
$audio = Get-LocalServiceSpec 'audio'
$listener = Get-LocalServiceSpec 'listener'
$tunnel = Get-LocalServiceSpec 'tunnel'
$created = [datetime]'2026-09-28T01:00:00Z'
$audioProcess = [pscustomobject]@{ ProcessId=101; CreationDate=$created; Name='python.exe'; ExecutablePath=$audio.Exe; CommandLine=('"' + $audio.Exe + '" -u -X utf8 "' + $audio.App + '"') }
Assert-Equal (Get-ServiceProcessRole $audio $audioProcess) 'service' 'Absolute audio entry must match'
$audioProcess.CommandLine = 'python.exe -u -X utf8 app.py'
Assert-Equal (Get-ServiceProcessRole $audio $audioProcess) '' 'Relative app alone must not authorize a stop'
Assert-Equal (Get-ServiceProcessRole $audio $audioProcess $true) 'service' 'Legacy audio needs corroborating PID and port'
$audioProcess.CommandLine = 'python.exe -u -X utf8 "' + $audio.App + '.other"'
Assert-Equal (Get-ServiceProcessRole $audio $audioProcess) '' 'Reject a matching path prefix'
$audioProcess.CommandLine = 'python.exe "' + $audio.App + '"'
$audioProcess.ExecutablePath = 'C:\other\python.exe'
Assert-Equal (Get-ServiceProcessRole $audio $audioProcess) '' 'Reject an unrelated Python environment'
$audioProcess.ExecutablePath = $audio.Exe
$audioProcess.CommandLine = $null
Assert-Equal (Get-ServiceProcessRole $audio $audioProcess) '' 'Unreadable elevated identities never authorize stopping'

$sensorProcess = [pscustomobject]@{ ProcessId=102; CreationDate=$created; Name='powershell.exe'; ExecutablePath='powershell.exe'; CommandLine=('powershell.exe -File "' + $listener.Watcher + '" -ListenerPath "' + $listener.ListenerPaths[0] + '" -Port 7777') }
Assert-Equal (Get-ServiceProcessRole $listener $sensorProcess) 'watcher' 'Sensor watcher must match exact script and listener'
$sensorProcess.CommandLine = $sensorProcess.CommandLine.Replace('7777','8888')
Assert-Equal (Get-ServiceProcessRole $listener $sensorProcess) '' 'Do not stop another sensor port'
$sensorProcess.CommandLine = 'powershell.exe -File "C:\other.ps1" -File "' + $listener.Watcher + '" -ListenerPath "' + $listener.ListenerPaths[0] + '"'
Assert-Equal (Get-ServiceProcessRole $listener $sensorProcess) '' 'A secondary fake -File argument must not authorize a stop'
$sensorProcess.CommandLine = 'powershell.exe -File "' + $listener.ListenerPaths[0] + '" -Port 7777'
Assert-Equal (Get-ServiceProcessRole $listener $sensorProcess) 'service' 'Standalone known sensor entry can be restarted'

$tunnelProcess = [pscustomobject]@{ ProcessId=103; CreationDate=$created; Name='cloudflared.exe'; ExecutablePath=$tunnel.Exe; CommandLine=('cloudflared.exe --config "' + $tunnel.Config + '" tunnel --metrics 127.0.0.1:0 run') }
Assert-Equal (Get-ServiceProcessRole $tunnel $tunnelProcess) 'service' 'Expected tunnel must match'
$tunnelProcess.CommandLine += ' --config "C:\other.yml"'
Assert-Equal (Get-ServiceProcessRole $tunnel $tunnelProcess) '' 'Conflicting configuration flags must fail closed'
$watcherProcess = [pscustomobject]@{ ProcessId=104; CreationDate=$created; Name='powershell.exe'; ExecutablePath='powershell.exe'; CommandLine=('powershell.exe -File "' + $tunnel.Watcher + '"') }
Assert-Equal (Get-ServiceProcessRole $tunnel $watcherProcess) 'watcher' 'Default watcher must match'
$watcherProcess.CommandLine += ' -Config "C:\other.yml"'
Assert-Equal (Get-ServiceProcessRole $tunnel $watcherProcess) '' 'A watcher for another configuration must not match'

# Exercise state inspection with process APIs replaced. Nothing touches live services.
$script:pidContents = @{}
$script:processes = @{}
$script:portOwners = @()
function Test-Path { param($LiteralPath) return $script:pidContents.ContainsKey($LiteralPath) }
function Get-Content { param($LiteralPath, [switch]$Raw) return $script:pidContents[$LiteralPath] }
function Get-NetTCPConnection { return @($script:portOwners | ForEach-Object { [pscustomobject]@{OwningProcess=$_} }) }
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -match '^ProcessId=(\d+)$') { return $script:processes[[int]$Matches[1]] }
    return @($script:processes.Values)
}
$audioProcess.CommandLine = 'python.exe -u -X utf8 app.py'
$script:processes[101] = $audioProcess
$script:pidContents[$audio.PidFiles[0]] = '101'
$script:portOwners = @(101)
$state = Get-LocalServiceState 'audio'
Assert-Equal $state.Verified $true 'Registered legacy audio with its port is accepted'
Assert-Equal $state.Processes.Count 1 'Port and PID discovery are deduplicated'
$script:portOwners = @(999)
Assert-Equal (Get-LocalServiceState 'audio').Verified $false 'Unknown port owner blocks a restart'
$script:portOwners = @(101)
$audioProcess.CommandLine = $null
$state = Get-LocalServiceState 'audio'
Assert-Equal $state.Running $true 'Unreadable process still prevents duplicate startup'
Assert-Equal $state.Verified $false 'Unreadable process never authorizes termination'
$script:processes = @{}; $script:portOwners = @()
Assert-Equal (Get-LocalServiceState 'audio').Running $false 'Dead PID files do not imply an active service'

# A PID reused between selection and stop must not be killed.
$audioProcess.CommandLine = 'python.exe -u -X utf8 "' + $audio.App + '"'
$entry = [pscustomobject]@{Process=$audioProcess; Role='service'; Verified=$true; LegacyAudio=$false}
$replacement = [pscustomobject]@{ProcessId=101; CreationDate=$created.AddSeconds(1); Name='python.exe'; ExecutablePath=$audio.Exe; CommandLine=$audioProcess.CommandLine}
$script:processes[101] = $replacement
$script:stops = 0
function Stop-Process { param($Id) $script:stops++; $script:processes.Remove([int]$Id) }
function Wait-Process { }
$rejected = $false
try { Stop-VerifiedServiceProcess $audio $entry } catch { $rejected = $true }
Assert-Equal $rejected $true 'Changed creation time must reject stop'
Assert-Equal $stops 0 'Reused PID stays untouched'
$script:processes[101] = $audioProcess
Stop-VerifiedServiceProcess $audio $entry
Assert-Equal $stops 1 'Verified original process is stopped exactly once'

# Run the restart coordinator against isolated files and process fixtures.
$operationRoot = Join-Path ([IO.Path]::GetTempPath()) ('flit-service-control-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($operationRoot) | Out-Null
$script:fixtureSpecs = @{}
foreach ($original in @($audio, $listener, $tunnel)) {
    $copy = $original.Clone(); $copy.Logs = $operationRoot
    $copy.PidFiles = @($original.PidFiles | ForEach-Object { Join-Path $operationRoot (Split-Path -Leaf $_) })
    $script:fixtureSpecs[$copy.Service] = $copy
}
function Get-LocalServiceSpec { param($Service) return $script:fixtureSpecs[$Service] }
function Test-Path { param($LiteralPath) return $script:pidContents.ContainsKey($LiteralPath) -or [IO.File]::Exists($LiteralPath) }
function Get-Content { param($LiteralPath, [switch]$Raw) if ($script:pidContents.ContainsKey($LiteralPath)) { return $script:pidContents[$LiteralPath] }; return [IO.File]::ReadAllText($LiteralPath) }
function Remove-Item { param($LiteralPath, [switch]$Force) $script:pidContents.Remove($LiteralPath); if ([IO.File]::Exists($LiteralPath)) { [IO.File]::Delete($LiteralPath) } }
function New-Object {
    $lock = [pscustomobject]@{}
    $lock | Add-Member ScriptMethod WaitOne { param($Timeout) return $true }
    $lock | Add-Member ScriptMethod ReleaseMutex { }
    $lock | Add-Member ScriptMethod Dispose { }
    return $lock
}
$script:operationEvents = @()
function Stop-Process {
    param($Id)
    $script:operationEvents += "stop:$Id"
    $script:processes.Remove([int]$Id)
    # Reproduce the watcher replacing its child just before it was stopped.
    if ($Id -eq 104) {
        $script:processes.Remove(103)
        $script:processes[105] = [pscustomobject]@{ProcessId=105; CreationDate=$created; Name='cloudflared.exe'; ExecutablePath=$tunnel.Exe; CommandLine=('cloudflared.exe --config "' + $tunnel.Config + '" tunnel run')}
        $script:pidContents[$fixtureSpecs.tunnel.PidFiles[1]] = '105'
    }
}
function Invoke-LocalServiceStart {
    param($Service)
    if ($script:processes.Count) { throw 'Start reached before old service stopped' }
    $script:operationEvents += "start:$Service"
}
try {
    $script:portOwners = @(); $script:pidContents = @{}; $script:processes = @{}
    $tunnelProcess.CommandLine = 'cloudflared.exe --config "' + $tunnel.Config + '" tunnel run'
    $watcherProcess.CommandLine = 'powershell.exe -File "' + $tunnel.Watcher + '"'
    $script:processes[103] = $tunnelProcess; $script:processes[104] = $watcherProcess
    $script:pidContents[$fixtureSpecs.tunnel.PidFiles[0]] = '104'; $script:pidContents[$fixtureSpecs.tunnel.PidFiles[1]] = '103'
    Invoke-LocalServiceOperation -Service tunnel -Restart
    Assert-Equal ($operationEvents -join ',') 'stop:104,stop:105,start:tunnel' 'Stop watcher first and recheck its replacement child'
    Assert-Equal ([IO.File]::Exists((Join-Path $operationRoot 'tunnel-watchdog.paused'))) $false 'Temporary pause is cleared'
    Assert-Equal $pidContents.Count 0 'Only dead service PID records are removed'

    foreach ($name in @('audio','listener')) {
        $script:operationEvents = @(); $script:pidContents = @{}; $script:processes = @{}
        $candidate = if ($name -eq 'audio') { $audioProcess } else { $sensorProcess }
        $script:processes[[int]$candidate.ProcessId] = $candidate
        $script:pidContents[$fixtureSpecs[$name].PidFiles[0]] = [string]$candidate.ProcessId
        Invoke-LocalServiceOperation -Service $name -Restart
        Assert-Equal ($operationEvents -join ',') ('stop:' + $candidate.ProcessId + ',start:' + $name) 'Restart targets only the selected service'
    }
    $script:operationEvents = @()
    $script:processes[999] = [pscustomobject]@{ProcessId=999; CreationDate=$created; Name='other.exe'; CommandLine='unrelated'; ExecutablePath='C:\other.exe'}
    $script:pidContents[$fixtureSpecs.audio.PidFiles[0]] = '999'
    $rejected = $false
    try { Invoke-LocalServiceOperation -Service audio -Restart } catch { $rejected = $true }
    Assert-Equal $rejected $true 'Unknown process refuses the entire operation'
    Assert-Equal $operationEvents.Count 0 'Refused operation stops and starts nothing'
} finally {
    $pause = Join-Path $operationRoot 'tunnel-watchdog.paused'
    if ([IO.File]::Exists($pause)) { [IO.File]::Delete($pause) }
    [IO.Directory]::Delete($operationRoot)
}

# Drive each menu; all mutation boundaries below are fixtures, not real actions.
$script:running = $true; $script:choice = 'close'; $script:starts = 0; $script:restarts = 0; $script:backendMenus = 0
function Get-LocalServiceState { return [pscustomobject]@{Running=$script:running; Verified=$false} }
function Invoke-LocalServiceOperation { $script:starts++ }
function Restart-ServiceFromWindow { $script:restarts++ }
function Invoke-BackendWindow { $script:backendMenus++; return 0 }
function Read-ServiceWindowAction { param($Service, [switch]$AllowRestart) if ($AllowRestart) { return $script:choice }; return 'close' }
function Write-Host { }
foreach ($name in @('listener','audio','tunnel')) {
    $script:running = $true; $script:choice = 'close'
    Assert-Equal (Invoke-ServiceWindow $name) 0 'Opening an existing service must succeed without elevation'
    Assert-Equal $starts 0 'Existing service must not start twice'
}
Assert-Equal $restarts 0 'Opening or timeout never restarts a service'
foreach ($name in @('listener','audio','tunnel')) {
    $script:running = $false; $script:choice = 'close'
    Assert-Equal (Invoke-ServiceWindow $name) 0 'Absent service starts'
}
Assert-Equal $starts 3 'Each absent service starts exactly once'
$script:running = $true; $script:choice = 'restart'
foreach ($name in @('listener','audio','tunnel')) { Assert-Equal (Invoke-ServiceWindow $name) 0 'Manual restart succeeds' }
Assert-Equal $restarts 3 'All three menus reach their restart adapter'
Assert-Equal (Invoke-ServiceWindow 'backend') 0 'Existing backend menu remains the shared reference'
Assert-Equal $backendMenus 1 'Backend menu is reused'
function Restart-ServiceFromWindow { throw 'fixture cancelled elevation' }
Assert-Equal (Invoke-ServiceWindow 'audio') 1 'Cancelled elevation is not reported as success'
Write-Output 'Service windows: exact identity, unreadable processes, legacy audio, PID reuse, no duplicate startup and explicit-only restart passed.'
