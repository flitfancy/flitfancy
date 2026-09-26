$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\backend_window.ps1')

function Assert-Equal($Actual, $Expected, $Message) {
    if ($Actual -ne $Expected) { throw "$Message (expected $Expected, got $Actual)" }
}

function Invoke-MenuFixture($Keys) {
    $fixture = @{ Index = 0; Time = [datetime]'2026-01-01'; Frames = @() }
    $result = Read-BackendWindowAction -AllowRestart -ReadKey {
        if ($fixture.Index -lt $Keys.Count) { $key = $Keys[$fixture.Index] } else { $key = '' }
        $fixture.Index++
        return $key
    } -Now { $fixture.Time } -Sleep { $fixture.Time = $fixture.Time.AddSeconds(1) } -Render {
        param($Selected, $Seconds, $CanRestart)
        $fixture.Frames += [pscustomobject]@{ Selected = $Selected; Seconds = $Seconds }
    }
    return @{ Action = $result; Fixture = $fixture }
}

$result = Invoke-MenuFixture @()
Assert-Equal $result.Action 'close' 'Inactivity must close, never restart'
Assert-Equal $result.Fixture.Index 15 'Default window lifetime must be 15 seconds'
Assert-Equal (Invoke-MenuFixture @('Enter')).Action 'close' 'Enter defaults to close'
Assert-Equal (Invoke-MenuFixture @('DownArrow', 'Enter')).Action 'restart' 'Down and Enter must select restart'
Assert-Equal (Invoke-MenuFixture @('DownArrow', 'UpArrow', 'Enter')).Action 'close' 'Up must return to close'
Assert-Equal (Invoke-MenuFixture @('DownArrow', 'Escape')).Action 'close' 'Escape must cancel restart'
$result = Invoke-MenuFixture (@('DownArrow') + (@('') * 20) + @('Enter'))
Assert-Equal $result.Action 'restart' 'Arrow navigation must stop the countdown'
Assert-Equal $result.Fixture.Frames[-1].Seconds -1 'Paused countdown must be shown'

# Identity checks use fixtures only, never inspect or stop the running service.
$script:pidExists = $true
$script:listeners = @([pscustomobject]@{ OwningProcess = 123 })
$serverPath = Join-Path (Split-Path -Parent $backendScripts) 'backend\server.py'
$script:processFixture = [pscustomobject]@{ ProcessId = 123; Name = 'python.exe'; CommandLine = 'python.exe "' + $serverPath + '"' }
function Test-Path { return $script:pidExists }
function Get-Content { return '123' }
function Get-CimInstance { return $script:processFixture }
function Get-NetTCPConnection { return $script:listeners }
Assert-Equal (Get-BackendWindowState).Verified $true 'Expected process must be accepted'
$processFixture.CommandLine += '.other'
Assert-Equal (Get-BackendWindowState).Verified $false 'Characters after a closing quote must not bypass the exact path check'
$processFixture.CommandLine = 'python.exe "' + $serverPath + '.other"'
Assert-Equal (Get-BackendWindowState).Verified $false 'Path prefix must not authorize another program'
$processFixture.CommandLine = $null
Assert-Equal (Get-BackendWindowState).Running $true 'Inaccessible elevated process must still open the menu'
Assert-Equal (Get-BackendWindowState).Verified $false 'Unreadable identity must not authorize a stop'
$processFixture.CommandLine = 'python.exe "' + $serverPath + '"'
$script:listeners = @([pscustomobject]@{ OwningProcess = 999 })
Assert-Equal (Get-BackendWindowState).Verified $false 'Port and PID disagreement must fail closed'
$script:listeners = @()
Assert-Equal (Get-BackendWindowState).Verified $true 'A stuck backend without a listener may be explicitly restarted'
$script:processFixture = $null
Assert-Equal (Get-BackendWindowState).Running $false 'Stale PID file must not imply a running process'
$script:listeners = @([pscustomobject]@{ OwningProcess = 999 })
Assert-Equal (Get-BackendWindowState).Running $true 'An occupied port must not trigger automatic startup'
Assert-Equal (Get-BackendWindowState).Verified $false 'Unknown port owner must not be stopped'

# Drive the actual entry function with process-changing boundaries replaced.
$script:running = $true
$script:starts = 0
$script:restarts = 0
$script:choice = 'close'
function Get-BackendWindowState { return [pscustomobject]@{ Running = $script:running } }
function Start-BackendFromWindow { $script:starts++ }
function Restart-BackendFromWindow { $script:restarts++ }
function Read-BackendWindowAction { return $script:choice }
function Write-Host { }
Assert-Equal (Invoke-BackendWindow) 0 'Existing backend close must succeed'
Assert-Equal $starts 0 'Opening the window must not start a second backend'
Assert-Equal $restarts 0 'Opening the window must not restart the backend'
$script:running = $false
Assert-Equal (Invoke-BackendWindow) 0 'Absent backend must start'
Assert-Equal $starts 1 'Missing backend must be started once'
$script:running = $true
$script:choice = 'restart'
Assert-Equal (Invoke-BackendWindow) 0 'Explicit restart must succeed'
Assert-Equal $restarts 1 'Only explicit selection may restart'
function Restart-BackendFromWindow { throw 'fixture UAC cancelled' }
Assert-Equal (Invoke-BackendWindow) 1 'Cancelled elevation must be reported, not shown as success'
Write-Output 'Backend window: 15-second timeout, arrow/Enter/Escape, paused countdown, process identity, startup, restart and cancelled elevation passed.'
