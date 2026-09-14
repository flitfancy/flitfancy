param([string]$Python = '', [switch]$Remove)
$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $siteRoot 'backend\launcher_agent.py'
$stateDir = Join-Path $siteRoot 'backend\data\launcher'
$startup = [Environment]::GetFolderPath('Startup')
$entry = Join-Path $startup 'FlitFancy Launcher.vbs'
if ($Remove) {
    if (Test-Path -LiteralPath $entry) { Remove-Item -LiteralPath $entry }
    Write-Host 'Removed the desktop-login startup entry. Existing launch cards are preserved.'
    exit 0
}
if (-not $Python) { $Python = (& py -3 -c 'import sys; print(sys.executable)').Trim() }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'Python executable not found.' }
$pythonw = Join-Path (Split-Path -Parent $Python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'pythonw.exe not found next to Python.' }
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Run this installer from the logged-in desktop.' }
foreach ($value in @($pythonw, $agent, $stateDir)) {
    if ($value.Contains('"')) { throw 'Paths cannot contain quotes.' }
}
$command = '"' + $pythonw + '" "' + $agent + '" --state-dir "' + $stateDir + '"'
$vbs = 'CreateObject("WScript.Shell").Run "' + $command.Replace('"', '""') + '", 0, False'
[IO.Directory]::CreateDirectory($startup) | Out-Null
[IO.File]::WriteAllText($entry, $vbs + "`r`n", [Text.Encoding]::Unicode)
Start-Process -FilePath $pythonw -ArgumentList ('"' + $agent + '" --state-dir "' + $stateDir + '"') -WindowStyle Hidden
Write-Host 'Desktop launcher installed and started. It will start after this Windows account logs in.'
