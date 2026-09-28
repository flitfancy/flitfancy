$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\service_control.ps1')
$now = [datetime]'2026-09-28T02:00:00Z'
$controller = Join-Path $localServiceScripts 'reload_service.ps1'
function Candidate($Number, $Path, $Service, $Seconds = 600) {
    return [pscustomobject]@{ProcessId=$Number; CreationDate=$now.AddSeconds(-$Seconds); Name='powershell.exe'; CommandLine=('powershell.exe -File "' + $Path + '" -Service ' + $Service)}
}
$script:candidates = @(
    (Candidate 101 $controller 'listener'),
    (Candidate 102 'C:\other.ps1' 'listener'),
    (Candidate 103 $controller 'audio'),
    (Candidate 104 $controller 'listener' 20),
    (Candidate 105 $controller 'listener'),
    (Candidate 106 $controller 'listener'),
    (Candidate 107 $controller 'listener'),
    (Candidate 108 (Join-Path $localServiceScripts 'watch_sensor_listener.ps1') 'listener')
)
$candidates[4].CommandLine = $null
$script:stopped = @()
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -match '^ProcessId=(\d+)$') {
        $found = $script:candidates | Where-Object ProcessId -eq ([int]$Matches[1]) | Select-Object -First 1
        if ($found.ProcessId -eq 107) { return Candidate 107 $controller 'listener' 1 }
        return $found
    }
    return $script:candidates
}
function Invoke-CimMethod {
    param($InputObject, $MethodName)
    if ($MethodName -ne 'GetOwnerSid') { throw 'Unexpected owner query' }
    return [pscustomobject]@{ReturnValue=0; Sid=$(if ($InputObject.ProcessId -eq 106) { 'fixture-other-user' } else { 'fixture-current-user' })}
}
function Stop-Process { param($Id, [switch]$Force) $script:stopped += $Id }
function Wait-Process { }
$retired = @(Clear-StaleServiceControllers -Service listener -Now $now -UserSid 'fixture-current-user')
if (($retired -join ',') -ne '101' -or ($stopped -join ',') -ne '101') { throw 'Stale-controller recovery must not touch live workers, other users/services, young controllers or reused PIDs.' }
Write-Output 'Stale restart recovery: exact helper, selected service, same user, timeout and creation identity enforced; workers untouched.'
