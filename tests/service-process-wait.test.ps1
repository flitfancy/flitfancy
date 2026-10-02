$ErrorActionPreference = 'Stop'
$scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('flit-process-wait-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$failures = @()
try {
    [IO.File]::WriteAllText((Join-Path $testRoot 'sleeper.ps1'), 'Start-Sleep -Seconds 60')
    [IO.File]::WriteAllText((Join-Path $testRoot 'reload_service.ps1'), @'
param([string]$Service)
$child = Start-Process powershell.exe -ArgumentList ('-NoProfile -File "' + (Join-Path $PSScriptRoot 'sleeper.ps1') + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'child.out') -RedirectStandardError (Join-Path $PSScriptRoot 'child.err')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'child.pid'), [string]$child.Id)
exit 0
'@)
    [IO.File]::WriteAllText((Join-Path $testRoot 'start_flitfancy.bat'), "@echo off`r`npowershell.exe -NoProfile -File `"%~dp0reload_service.ps1`"`r`nexit /b 0`r`n")
    Copy-Item -LiteralPath (Join-Path $testRoot 'reload_service.ps1') -Destination (Join-Path $testRoot 'reload_backend.ps1')
    [IO.File]::WriteAllText((Join-Path $testRoot 'runner.ps1'), @'
param([string]$Scripts, [string]$Mode)
$ErrorActionPreference = 'Stop'
if ($Mode -in @('window','backend')) {
    . (Join-Path $Scripts 'service_window.ps1')
    function New-Object {
        $principal = [pscustomobject]@{}
        $principal | Add-Member ScriptMethod IsInRole { param($Role) return $true }
        return $principal
    }
} else {
    . (Join-Path $Scripts 'service_control.ps1')
    function Get-LocalServiceState { return [pscustomobject]@{Running=$false; Verified=$true} }
    function Test-LocalServiceReady { return $true }
}
$localServiceScripts = $PSScriptRoot
$backendScripts = $PSScriptRoot
if ($Mode -eq 'window') { Restart-ServiceFromWindow 'listener' }
elseif ($Mode -eq 'backend') { Restart-BackendFromWindow }
elseif ($Mode -eq 'boot') {
    if ((Invoke-LocalBootStarter -Scripts $PSScriptRoot -OutLog (Join-Path $PSScriptRoot 'boot-starter.out') -ErrLog (Join-Path $PSScriptRoot 'boot-starter.err')) -ne 0) { throw 'Boot starter failed.' }
}
else { Invoke-LocalServiceStart 'listener' }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot ($Mode + '.done')), 'completed')
'@)
    foreach ($mode in @('window', 'starter', 'backend', 'boot')) {
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $testRoot 'runner.ps1') + '" -Scripts "' + $scripts + '" -Mode ' + $mode
        $runner = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot ($mode + '.out')) -RedirectStandardError (Join-Path $testRoot ($mode + '.err'))
        $deadline = [datetime]::UtcNow.AddSeconds(8)
        $marker = Join-Path $testRoot ($mode + '.done')
        while (-not [IO.File]::Exists($marker) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        $finished = [IO.File]::Exists($marker)
        $childAlive = $false
        if ([IO.File]::Exists((Join-Path $testRoot 'child.pid'))) {
            $childId = [int][IO.File]::ReadAllText((Join-Path $testRoot 'child.pid'))
            $childAlive = [bool](Get-Process -Id $childId -ErrorAction SilentlyContinue)
        }
        if (-not $finished -or -not $childAlive) { $failures += $mode }
        # Only fixture commands containing this unique temp path can be terminated.
        Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(powershell|cmd)\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($testRoot) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 3 -ErrorAction SilentlyContinue }
        $runner.Dispose()
        Remove-Item -LiteralPath (Join-Path $testRoot 'child.pid') -Force -ErrorAction SilentlyContinue
    }
    if ($failures.Count) { throw ('Waiting incorrectly included the persistent service child: ' + ($failures -join ', ')) }
    Write-Output 'Service process waits: auxiliary menu, backend menu, starter and boot launcher return while persistent children remain running.'
} finally {
    Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(powershell|cmd)\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($testRoot) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 3 -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $testRoot -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    Remove-Item -LiteralPath $testRoot -Force
}
