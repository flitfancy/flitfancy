param(
    [string]$ListenerPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ListenerPath) {
    $ListenerPath = Join-Path (Split-Path $PSScriptRoot -Parent) `
        'scripts\vendor\listen_wifi.ps1'
}
if (-not (Test-Path -LiteralPath $ListenerPath -PathType Leaf)) {
    throw "Sensor listener not found: $ListenerPath"
}

$portProbe = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$testPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'flitfancy-sensor-storage-' + [Guid]::NewGuid().ToString('N'))
$sessionsRoot = Join-Path $testRoot 'sessions'
[void][System.IO.Directory]::CreateDirectory($sessionsRoot)

$oldSession = Join-Path $sessionsRoot 'wifi-20200101-000000.csv'
$recentSession = Join-Path $sessionsRoot 'wifi-20990101-000000.csv'
Set-Content -LiteralPath $oldSession -Value "pc_time,uptime_ms`nold,1" -Encoding UTF8
Set-Content -LiteralPath $recentSession -Value "pc_time,uptime_ms`nrecent,2" -Encoding UTF8
(Get-Item -LiteralPath $oldSession).LastWriteTime = (Get-Date).AddDays(-30)

$stdoutPath = Join-Path $testRoot 'listener.out.log'
$stderrPath = Join-Path $testRoot 'listener.err.log'
$listenerProcess = $null
$client = $null

try {
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $ListenerPath + '"'),
        '-Port', $testPort,
        '-DataRoot', ('"' + $testRoot + '"'),
        '-NoFlitFancy',
        '-Quiet',
        '-TimeoutSeconds', 5
    ) -join ' '
    $listenerProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline -and
        -not (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue)) {
        throw "Listener did not open TCP :$testPort."
    }

    $archiveRoot = Join-Path $testRoot 'archive\sessions'
    foreach ($name in @('wifi-20200101-000000.csv', 'wifi-20990101-000000.csv')) {
        if (-not (Test-Path -LiteralPath (Join-Path $archiveRoot $name) -PathType Leaf)) {
            throw "Completed session was not archived: $name"
        }
        if (Test-Path -LiteralPath (Join-Path $sessionsRoot $name)) {
            throw "Completed session remained in the live sessions directory: $name"
        }
    }

    $client = [System.Net.Sockets.TcpClient]::new()
    $client.Connect([System.Net.IPAddress]::Loopback, $testPort)
    $stream = $client.GetStream()
    $lines = @(
        'HELLO,storage-regression',
        'CSV,uptime_ms,cycle,channel,sensor,ok,temp_c',
        'CSV,1000,1,0,SHT41,1,23.5'
    ) -join "`n"
    $payload = [System.Text.Encoding]::UTF8.GetBytes($lines + "`n")
    $stream.Write($payload, 0, $payload.Length)
    $stream.Flush()

    $sessionDeadline = [DateTime]::UtcNow.AddSeconds(3)
    $writtenSession = $null
    while ([DateTime]::UtcNow -lt $sessionDeadline) {
        $writtenSession = Get-ChildItem -LiteralPath $sessionsRoot -File `
            -Filter 'wifi-*.csv' | Select-Object -First 1
        if ($writtenSession -and $writtenSession.Length -gt 0) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $writtenSession) {
        throw 'Listener did not create a new session file.'
    }

    $streamReader = [System.IO.File]::Open(
        $writtenSession.FullName,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite)
    try {
        $reader = [System.IO.StreamReader]::new($streamReader)
        try { $writtenLines = @($reader.ReadToEnd() -split "`r?`n") }
        finally { $reader.Dispose() }
    } finally {
        $streamReader.Dispose()
    }
    $firstData = $writtenLines | Where-Object { $_ -match ',1000,1,0,SHT41,' } |
        Select-Object -First 1
    if ($firstData -notmatch '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3},') {
        throw "Sensor row does not contain a real PC timestamp: $firstData"
    }

    Write-Host 'PASS: completed sessions are archived and new rows use real PC timestamps.'
} finally {
    if ($null -ne $client) {
        try { $client.Close() } catch {}
    }
    if ($null -ne $listenerProcess) {
        $listenerProcess.Refresh()
        if (-not $listenerProcess.HasExited) {
            Stop-Process -Id $listenerProcess.Id -Force -ErrorAction SilentlyContinue
            [void]$listenerProcess.WaitForExit(3000)
        }
        $listenerProcess.Dispose()
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    if (Test-Path -LiteralPath $testRoot) {
        [System.IO.Directory]::Delete($testRoot, $true)
    }
}
