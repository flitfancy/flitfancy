$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('flit-tunnel-starter-' + [guid]::NewGuid().ToString('N'))
$fixtureScripts = Join-Path $fixtureRoot 'site\scripts'
$fixtureLogs = Join-Path $fixtureRoot 'logs'
[IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
[IO.Directory]::CreateDirectory($fixtureLogs) | Out-Null
$starter = Join-Path $fixtureScripts 'start_tunnel.ps1'
$wrapper = Join-Path $fixtureRoot 'fixture.ps1'
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\start_tunnel.ps1') -Destination $starter
    [IO.File]::WriteAllText((Join-Path $fixtureLogs 'tunnel-watchdog.pid'), '123')
    # Run the actual starter with an unreadable elevated watcher, not real processes.
    [IO.File]::WriteAllText($wrapper, @'
param([string]$Starter, [string]$Mode)
$ErrorActionPreference = 'Stop'
function Get-CimInstance {
    $cmd = if ($Mode -eq 'hidden') { $null } else { 'powershell.exe -File "' + (Join-Path (Split-Path -Parent $Starter) 'watch_tunnel.ps1') + '"' }
    return [pscustomobject]@{ProcessId=123; Name='powershell.exe'; CommandLine=$cmd}
}
function New-Object {
    $lock = [pscustomobject]@{}
    $lock | Add-Member ScriptMethod WaitOne { param($Timeout) return $true }
    $lock | Add-Member ScriptMethod ReleaseMutex { }
    $lock | Add-Member ScriptMethod Dispose { }
    return $lock
}
function Start-Process { throw 'Fixture detected a duplicate watchdog launch.' }
& $Starter
exit $LASTEXITCODE
'@)
    foreach ($mode in @('hidden', 'readable')) {
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper -Starter $starter -Mode $mode 2>&1
        if ($LASTEXITCODE -ne 0) { throw "$mode watcher: starter attempted to duplicate an existing watcher: $output" }
    }
    Write-Output 'Tunnel starter: existing readable and elevated/unreadable watchers are preserved without a second launch.'
} finally {
    foreach ($file in @($starter, $wrapper, (Join-Path $fixtureLogs 'tunnel-watchdog.pid'))) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $fixtureScripts -Force
    Remove-Item -LiteralPath (Split-Path -Parent $fixtureScripts) -Force
    Remove-Item -LiteralPath $fixtureLogs -Force
    Remove-Item -LiteralPath $fixtureRoot -Force
}
