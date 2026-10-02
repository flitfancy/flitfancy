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

function Read-SharedCsv([string]$Path) {
    $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = [System.IO.StreamReader]::new($file)
        try { return $reader.ReadToEnd() }
        finally { $reader.Dispose() }
    } finally { $file.Dispose() }
}

function Send-AndConfirm($Connection, [string[]]$Lines) {
    $Connection.ReceiveTimeout = 3000
    $connectionStream = $Connection.GetStream()
    $marker = [Guid]::NewGuid().ToString('N')
    $payload = [System.Text.Encoding]::UTF8.GetBytes(
        (($Lines + @("PING $marker")) -join "`n") + "`n")
    $connectionStream.Write($payload, 0, $payload.Length)
    $connectionStream.Flush()
    $reader = [System.IO.StreamReader]::new(
        $connectionStream, [System.Text.Encoding]::UTF8, $false, 1024, $true)
    try {
        if ($reader.ReadLine() -ne "PONG $marker") {
            throw 'Listener did not finish processing the preceding CSV rows.'
        }
    } finally { $reader.Dispose() }
}

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
    Send-AndConfirm $client @(
        'HELLO,storage-regression',
        'CSV,uptime_ms,cycle,channel,sensor,ok,temp_c',
        'CSV,1000,1,0,SHT41,1,23.5'
    )
    $writtenSession = Get-ChildItem -LiteralPath $sessionsRoot -File `
        -Filter 'wifi-*.csv' | Select-Object -First 1
    if (-not $writtenSession) {
        throw 'Listener did not create a new session file.'
    }

    $writtenLines = @((Read-SharedCsv $writtenSession.FullName) -split "`r?`n")
    $firstData = $writtenLines | Where-Object { $_ -match ',1000,1,0,SHT41,' } |
        Select-Object -First 1
    if ($firstData -notmatch '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3},') {
        throw "Sensor row does not contain a real PC timestamp: $firstData"
    }

    $oldHeader = 'uptime_ms,cycle,channel,sensor,ok,temp_c'
    $heartHeader = $oldHeader + ',heart_rate_bpm,hr_connected,hr_contact,hr_state'
    Send-AndConfirm $client @("CSV,$oldHeader")
    $client.Close()
    $client = [System.Net.Sockets.TcpClient]::new()
    $client.Connect([System.Net.IPAddress]::Loopback, $testPort)
    Send-AndConfirm $client @('HELLO,same-schema-reconnect', "CSV,$oldHeader",
        'CSV,2000,2,0,SHT41,1,24.0')
    $sameSchemaFiles = @(Get-ChildItem -LiteralPath $sessionsRoot -File -Filter 'wifi-*.csv')
    $originalCsv = Read-SharedCsv $writtenSession.FullName
    $originalLines = @($originalCsv -split "`r?`n" | Where-Object { $_ })
    if ($sameSchemaFiles.Count -ne 1 -or $originalLines.Count -ne 3 -or
        @($originalLines | Where-Object { $_ -eq "pc_time,$oldHeader" }).Count -ne 1) {
        throw 'Same-schema reconnect must retain one session with one header and both rows.'
    }

    # Reserve the first rotation suffix to prove a new session never truncates an existing file.
    $collisionPath = Join-Path $sessionsRoot ($writtenSession.BaseName + '-1.csv')
    $collisionText = "pc_time,uptime_ms`nreserved,42`n"
    [System.IO.File]::WriteAllText($collisionPath, $collisionText)
    Send-AndConfirm $client @("CSV,$heartHeader",
        'CSV,3000,3,6,BLE-HR,1,NA,76,1,NA,streaming')
    $rotated = @(Get-ChildItem -LiteralPath $sessionsRoot -File -Filter 'wifi-*.csv' |
        Where-Object { $_.FullName -ne $collisionPath })
    if ($rotated.Count -ne 2) {
        throw 'A changed CSV header must rotate to a new session instead of mixing schemas.'
    }
    if ((Read-SharedCsv $writtenSession.FullName) -cne $originalCsv -or
        [System.IO.File]::ReadAllText($collisionPath) -cne $collisionText) {
        throw 'Schema rotation overwrote an existing session.'
    }
    $heartFile = $rotated | Where-Object { $_.FullName -ne $writtenSession.FullName }
    $heartCsv = Read-SharedCsv $heartFile.FullName
    $heartRows = @($heartCsv | ConvertFrom-Csv)
    if ($heartRows.Count -ne 1 -or $heartRows[0].heart_rate_bpm -ne '76' -or
        $heartRows[0].hr_state -ne 'streaming') {
        throw 'Rotated session does not map new heart-rate fields by its own header.'
    }
    $livePath = Join-Path $testRoot 'live\firefly_live.csv'
    if ((Read-SharedCsv $livePath) -cne $heartCsv) {
        throw 'Live CSV must reset to the current schema and current-session rows.'
    }

    # A different field name with the same column count is also a new schema.
    $renamedHeader = $heartHeader.Replace('temp_c', 'rh_pct')
    Send-AndConfirm $client @("CSV,$renamedHeader",
        'CSV,4000,4,6,BLE-HR,1,NA,77,1,NA,streaming', "CSV,$renamedHeader",
        'CSV,5000,5,6,BLE-HR,1,NA,78,1,NA,streaming')
    $finalFiles = @(Get-ChildItem -LiteralPath $sessionsRoot -File -Filter 'wifi-*.csv' |
        Where-Object { $_.FullName -ne $collisionPath })
    if ($finalFiles.Count -ne 3 -or (Read-SharedCsv $heartFile.FullName) -cne $heartCsv -or
        (Read-SharedCsv $writtenSession.FullName) -cne $originalCsv) {
        throw 'Repeated schema changes must create distinct files and preserve completed sessions.'
    }
    $liveLines = @((Read-SharedCsv $livePath) -split "`r?`n" | Where-Object { $_ })
    if ($liveLines.Count -ne 3 -or $liveLines[0] -cne "pc_time,$renamedHeader") {
        throw 'Same-column-count schema change or duplicate header handling is incorrect.'
    }
    foreach ($sessionFile in $finalFiles) {
        $csvLines = @((Read-SharedCsv $sessionFile.FullName) -split "`r?`n" | Where-Object { $_ })
        $expectedWidth = $csvLines[0].Split(',').Count
        if (@($csvLines | Where-Object { $_.Split(',').Count -ne $expectedWidth }).Count) {
            throw "Session contains rows that differ from its header: $($sessionFile.Name)"
        }
    }

    Write-Host 'PASS: archives, timestamps, same-schema reconnects, schema rotation, live reset and collision preservation.'
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
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
        $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
        if ((Split-Path -Parent $resolvedTestRoot) -ine $expectedParent -or
            (Split-Path -Leaf $resolvedTestRoot) -notmatch '^flitfancy-sensor-storage-[0-9a-f]{32}$') {
            throw "Refusing to remove an unexpected test directory: $resolvedTestRoot"
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
