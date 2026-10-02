$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixtureBase = Join-Path $root 'security-work\backend-watchdog-fixtures'
$fixtureRoot = Join-Path $fixtureBase ([guid]::NewGuid().ToString('N'))
$scripts = Join-Path $fixtureRoot 'site\scripts'
$backend = Join-Path $fixtureRoot 'site\backend'
$logs = Join-Path $fixtureRoot 'logs'
New-Item -ItemType Directory -Path $scripts,$backend,$logs -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\watch_backend.ps1') -Destination (Join-Path $scripts 'watch_backend.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\backend_identity.ps1') -Destination (Join-Path $scripts 'backend_identity.ps1')
$server = Join-Path $backend 'server.py'
[IO.File]::WriteAllText($server, @'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'name':'flitfancy'}).encode()
        self.send_response(200); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()
'@)
$socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$socket.Start(); $port = $socket.LocalEndpoint.Port; $socket.Stop()
# Put the fixture port in the copied server so the production watchdog uses its normal invocation.
$source = [IO.File]::ReadAllText($server).Replace('int(sys.argv[1])',[string]$port)
[IO.File]::WriteAllText($server,$source)
$sleepScript = Join-Path $fixtureRoot 'unrelated-fixture.ps1'
[IO.File]::WriteAllText($sleepScript,'Start-Sleep -Seconds 45')
$unrelated = Start-Process powershell.exe -ArgumentList ('-NoProfile -File "' + $sleepScript + '"') -WindowStyle Hidden -PassThru
$unrelatedIdentity = Get-CimInstance Win32_Process -Filter "ProcessId=$($unrelated.Id)"
$watcher = $null
$serverIdentity = $null
try {
    [IO.File]::WriteAllText((Join-Path $logs 'backend-watchdog.pid'),[string]$unrelated.Id)
    [IO.File]::WriteAllText((Join-Path $logs 'backend.pid'),[string]$unrelated.Id)
    $helper = Join-Path $PSScriptRoot '..\scripts\svc_helpers.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -Action backend-watchdog-alive -ProcessId $unrelated.Id -Watchdog (Join-Path $scripts 'watch_backend.ps1')
    if ($LASTEXITCODE -eq 0) { throw 'Starter treated an unrelated reused PID as a backend watchdog.' }
    $python = (& py -3 -c 'import sys; print(sys.executable)').Trim()
    $url = 'http://127.0.0.1:' + $port + '/api/status'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $scripts 'watch_backend.ps1') + '" -ServerPath "' + $server + '" -Exe "' + $python + '" -WorkDir "' + $backend + '" -PidFile "' + (Join-Path $logs 'backend.pid') + '" -Url "' + $url + '" -HealthIntervalSeconds 1'
    $watcher = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'watcher.out') -RedirectStandardError (Join-Path $logs 'watcher.err')
    $watcherIdentity = Get-CimInstance Win32_Process -Filter "ProcessId=$($watcher.Id)"
    $deadline = [datetime]::UtcNow.AddSeconds(7)
    $healthy = $false
    do {
        try { $healthy = (Invoke-RestMethod $url -TimeoutSec 1).name -eq 'flitfancy' } catch { }
        if ($healthy -or $watcher.HasExited) { break }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $healthy) { throw 'Reused watchdog PID incorrectly prevented the website backend from starting.' }
    $serverId = [int][IO.File]::ReadAllText((Join-Path $logs 'backend.pid'))
    $serverIdentity = Get-CimInstance Win32_Process -Filter "ProcessId=$serverId"
    if (-not (Get-Process -Id $unrelated.Id -ErrorAction SilentlyContinue)) { throw 'Reused backend PID incorrectly terminated an unrelated process.' }
    if ($serverId -eq $unrelated.Id) { throw 'Backend PID was not replaced with the new server identity.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -Action backend-watchdog-alive -ProcessId $watcher.Id -Watchdog (Join-Path $scripts 'watch_backend.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Starter failed to recognize the verified watchdog.' }
    Write-Output 'Backend watchdog: stale/reused watcher and backend PIDs recover; unrelated processes remain alive.'
} finally {
    # Fixture evidence remains in security-work. Only our unique fixture commands can be stopped.
    foreach ($identity in @($serverIdentity,$watcherIdentity,$unrelatedIdentity)) {
        if (-not $identity) { continue }
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.ProcessId)"
        if ($current -and $current.CreationDate -eq $identity.CreationDate -and $current.CommandLine -and $current.CommandLine.Contains($fixtureRoot)) {
            Stop-Process -Id $current.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}
