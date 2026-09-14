$ErrorActionPreference = 'Stop'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('flit tunnel ' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$fixtureExe = Join-Path $tempRoot 'cloudflared.exe'
$fixtureConfig = Join-Path $tempRoot 'config.yml'
$fixturePidFile = Join-Path $tempRoot 'cloudflared.pid'
$watch = $null
$second = $null
function Wait-Condition([scriptblock]$Condition, [int]$Seconds = 45) {
    $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 250
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Timed out waiting for watchdog recovery.'
}
try {
    # A local-only fake tunnel: no Cloudflare credentials or network connection.
    Add-Type -OutputAssembly $fixtureExe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
public class TunnelFixture {
    public static void Main(string[] args) {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        while (true) {
            using (var client = listener.AcceptTcpClient()) {
                client.ReceiveTimeout = 3000;
                var stream = client.GetStream();
                var reader = new StreamReader(stream);
                try {
                    string line;
                    do { line = reader.ReadLine(); } while (!String.IsNullOrEmpty(line));
                    var bytes = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                    stream.Write(bytes, 0, bytes.Length);
                } catch (IOException) {}
            }
        }
    }
}
'@
    [IO.File]::WriteAllText($fixtureConfig, '# isolated fixture')
    $watcher = Join-Path $PSScriptRoot '..\scripts\watch_tunnel.ps1'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $watcher + '" -Exe "' +
        $fixtureExe + '" -Config "' + $fixtureConfig + '" -WorkDir "' + $tempRoot + '" -Logs "' + $tempRoot + '"'
    $watch = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $tempRoot 'watch.out') -RedirectStandardError (Join-Path $tempRoot 'watch.err')
    Wait-Condition { Test-Path -LiteralPath $fixturePidFile }
    $firstPid = [int](Get-Content -LiteralPath $fixturePidFile -Raw)
    $fixture = Get-CimInstance Win32_Process -Filter "ProcessId=$firstPid"
    if ($fixture.ExecutablePath -ne $fixtureExe) { throw 'Fixture identity mismatch' }
    # The second watcher must exit and leave the first watcher's PID intact.
    $second = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $second.WaitForExit(10000)) { throw 'Duplicate watcher did not exit' }
    if ($second.ExitCode -ne 0) { throw 'Duplicate watcher failed unexpectedly' }
    if ([int](Get-Content (Join-Path $tempRoot 'tunnel-watchdog.pid') -Raw) -ne $watch.Id) {
        throw 'Duplicate watcher changed the active PID'
    }
    # Exercise actual termination and recovery, strictly against the temp executable.
    $recoveryClock = [Diagnostics.Stopwatch]::StartNew()
    Stop-Process -Id $firstPid -Force
    Wait-Condition {
        $nextPid = [int](Get-Content -LiteralPath $fixturePidFile -Raw)
        $nextPid -ne $firstPid -and (Get-Process -Id $nextPid -ErrorAction SilentlyContinue)
    }
    $recoveredPid = [int](Get-Content -LiteralPath $fixturePidFile -Raw)
    $recovered = Get-CimInstance Win32_Process -Filter "ProcessId=$recoveredPid"
    if ($recovered.ExecutablePath -ne $fixtureExe) { throw 'Recovered process identity mismatch' }
    $ports = Get-NetTCPConnection -State Listen -OwningProcess $recoveredPid
    $ready = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri ('http://127.0.0.1:{0}/ready' -f $ports[0].LocalPort)
    if ($ready.StatusCode -ne 200) { throw 'Recovered tunnel was not ready' }
    $errors = Get-Content (Join-Path $tempRoot 'watch.err') -Raw
    if ($errors) { throw 'Watchdog wrote unexpected errors' }
    Write-Output ('Tunnel integration passed: duplicate prevented; terminated fixture recovered in {0:N1}s.' -f $recoveryClock.Elapsed.TotalSeconds)
} finally {
    foreach ($process in @($watch, $second)) {
        if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
    }
    Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { $_.ExecutablePath -eq $fixtureExe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Wait-Process -Id $_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }
    # Only known fixture files; no recursive removal.
    foreach ($name in @('cloudflared.exe', 'config.yml', 'cloudflared.pid', 'tunnel-watchdog.pid',
        'cloudflared.out.log', 'cloudflared.err.log', 'watch.out', 'watch.err')) {
        Remove-Item -LiteralPath (Join-Path $tempRoot $name) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $tempRoot -Force
}
