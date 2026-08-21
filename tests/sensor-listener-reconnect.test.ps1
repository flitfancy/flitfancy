param(
    [string]$ListenerPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ListenerPath) {
    # 监听器正本在站点仓库内（scripts\vendor\），自包含、无需外部工作区。
    $scriptDir = if ($PSScriptRoot) {
        $PSScriptRoot
    } elseif ($PSCommandPath) {
        Split-Path -Parent $PSCommandPath
    } elseif ($MyInvocation.MyCommand.Path) {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        ''
    }
    if (-not $scriptDir) {
        throw '无法推导脚本目录；请显式传入 -ListenerPath。'
    }
    $ListenerPath = Join-Path (Split-Path $scriptDir -Parent) 'scripts\vendor\listen_wifi.ps1'
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
    'flitfancy-sensor-listener-' + [Guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($testRoot)
$stdoutPath = Join-Path $testRoot 'listener.out.log'
$stderrPath = Join-Path $testRoot 'listener.err.log'
$listenerProcess = $null
$firstClient = $null
$secondClient = $null

try {
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $ListenerPath + '"'),
        '-Port', $testPort,
        '-DataRoot', ('"' + $testRoot + '"'),
        '-NoFlitFancy',
        '-Quiet',
        '-TimeoutSeconds', 30
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

    $firstClient = [System.Net.Sockets.TcpClient]::new()
    $firstClient.Connect([System.Net.IPAddress]::Loopback, $testPort)
    Start-Sleep -Milliseconds 500
    $firstClient.Client.LingerState = [System.Net.Sockets.LingerOption]::new($true, 0)
    $firstClient.Close()
    $firstClient = $null

    # The former bug surfaced on the next 10-second PC heartbeat write.
    Start-Sleep -Seconds 12
    $listenerProcess.Refresh()
    if ($listenerProcess.HasExited) {
        throw 'Listener exited after the client reset its TCP connection.'
    }
    if (-not (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue)) {
        throw 'Listener process survived, but its TCP listening socket is gone.'
    }

    $secondClient = [System.Net.Sockets.TcpClient]::new()
    $secondClient.ReceiveTimeout = 3000
    $secondClient.Connect([System.Net.IPAddress]::Loopback, $testPort)
    $secondStream = $secondClient.GetStream()
    $payload = [System.Text.Encoding]::UTF8.GetBytes("PING regression`n")
    $secondStream.Write($payload, 0, $payload.Length)
    $secondStream.Flush()
    $secondReader = [System.IO.StreamReader]::new(
        $secondStream, [System.Text.Encoding]::UTF8, $false, 1024, $true)
    $confirmed = $false
    $readDeadline = [DateTime]::UtcNow.AddSeconds(3)
    while ([DateTime]::UtcNow -lt $readDeadline) {
        $response = $secondReader.ReadLine()
        if ($response -eq 'PONG regression') {
            $confirmed = $true
            break
        }
    }
    $secondReader.Dispose()
    if (-not $confirmed) {
        throw 'Listener accepted a reconnect but did not answer the heartbeat.'
    }

    Write-Host "PASS: listener survived TCP reset and accepted a reconnect on :$testPort."
} finally {
    if ($null -ne $firstClient) {
        try { $firstClient.Close() } catch {}
    }
    if ($null -ne $secondClient) {
        try { $secondClient.Close() } catch {}
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
