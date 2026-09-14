param(
    [int]$Port = 7777,
    [string]$DataRoot = '',
    [switch]$NoFlitFancy,
    [switch]$Quiet,
    [int]$TimeoutSeconds = 0,
    [switch]$StartStream
)

# FIREFLY-SENSE 感知板 TCP 监听器（2026-08 契约重写版）
#
# 契约（由 site/tests/sensor-listener-reconnect.test.ps1 钉死）：
#   - 监听 TCP -Port（0.0.0.0），逐连接读取板端行流；
#   - "PING <n>" -> 回 "PONG <n>"（双向心跳；板端每 3 s 发 PING 确认链路）；
#   - "HELLO,..." 记录固件元数据，不转发；
#   - "CSV,uptime_ms,..." 是固件自带表头：写一次 pc_time, 前缀后落盘，不转发；
#   - "CSV,..." 数据行：加 pc_time 前缀，写会话文件 + live 文件，并 POST 到
#     本机后端 /api/ingest（除非 -NoFlitFancy）；
#   - 任何读写异常（TCP RST/断线）只释放当前连接并回到 accept 循环，绝不退出；
#   - -TimeoutSeconds：新连接在收到 HELLO 之前允许的空闲秒数（0 = 不限），
#     用于挡住健康探测等不发数据的连接；
#   - -StartStream：对每个发来 HELLO 的板子补发一次 "MODE 2"（正常 10 s 上报
#     档），确保板子进入持续上报（固件 1.3.0 起开机即 Normal，此为保险补发）。

$ErrorActionPreference = 'Stop'

function Log-Info([string]$Message) {
    if (-not $Quiet) {
        Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Message)
    }
}

function Log-Error([string]$Message) {
    Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] [error] ' + $Message)
}

if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    # 默认指向站点仓库的传感器目录：S:\FlitFancy\site\data\sensors。
    $DataRoot = Join-Path $PSScriptRoot '..\..\..\..\FlitFancy\site\data\sensors'
}
$sessionsRoot = Join-Path $DataRoot 'sessions'
$liveDir = Join-Path $DataRoot 'live'
$archiveSessionsRoot = Join-Path $DataRoot 'archive\sessions'
[void][System.IO.Directory]::CreateDirectory($sessionsRoot)
[void][System.IO.Directory]::CreateDirectory($liveDir)
[void][System.IO.Directory]::CreateDirectory($archiveSessionsRoot)

# 监听器启动时，sessions 中不可能存在本进程正在写入的文件；其中全部是
# 上一次或更早的已结束会话。先移入永久归档，再创建本次会话文件。
# 原始 CSV 不跟随 SQLite 的 14 天查询窗口清理。
try {
    $archived = 0
    foreach ($completed in Get-ChildItem -LiteralPath $sessionsRoot -File -Filter 'wifi-*.csv') {
        try {
            $destination = Join-Path $archiveSessionsRoot $completed.Name
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                $sourceHash = (Get-FileHash -LiteralPath $completed.FullName -Algorithm SHA256).Hash
                $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
                if ($sourceHash -eq $destinationHash) {
                    # 归档中已有完全相同的副本，删除 sessions 中的重复文件即可。
                    Remove-Item -LiteralPath $completed.FullName -Force
                    $archived++
                    continue
                }
                $stem = [System.IO.Path]::GetFileNameWithoutExtension($completed.Name)
                $destination = Join-Path $archiveSessionsRoot (
                    $stem + '-collision-' + $sourceHash.Substring(0, 12).ToLowerInvariant() + '.csv')
            }
            Move-Item -LiteralPath $completed.FullName -Destination $destination
            $archived++
        } catch {
            Log-Error ('archive skip: ' + $completed.Name + ': ' + $_.Exception.Message)
        }
    }
    if ($archived -gt 0) {
        Log-Info ("archived $archived completed session(s)")
    }
} catch {
    Log-Error ('session archive failed: ' + $_.Exception.Message)
}

# 会话文件：每次监听进程运行一个（$stamp 启动时生成）。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutFile = Join-Path $sessionsRoot "wifi-$stamp.csv"
$LiveFile = Join-Path $liveDir 'firefly_live.csv'

$writer = $null          # 会话文件（UTF-8 BOM，逐行 flush，避免异常退出丢尾行）
$liveWriter = $null      # live 文件（UTF-8 无 BOM，AutoFlush）
$headerWritten = $false

# 转发客户端（复用连接，避免逐行重建）。
$http = $null
$ingestUri = [Uri]'http://127.0.0.1:2671/api/ingest'
$forwardErrors = 0
$useHttpClient = $false
if (-not $NoFlitFancy) {
    try {
        # Windows PowerShell 5.1 默认不加载 System.Net.Http。
        Add-Type -AssemblyName System.Net.Http
        $useHttpClient = $true
    } catch {
        Log-Error 'System.Net.Http unavailable; forwarding falls back to Invoke-RestMethod.'
    }
}

function Get-IngestClient {
    if ($null -eq $script:http) {
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.UseProxy = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(5)
        $client.DefaultRequestHeaders.Add('X-Firefly-Board', 'FIREFLY-SENSE')
        $script:http = $client
    }
    return $script:http
}

function Forward-Line([string]$Fields) {
    try {
        if ($script:useHttpClient) {
            $content = [System.Net.Http.StringContent]::new(
                'CSV,' + $Fields, [System.Text.Encoding]::UTF8)
            $response = (Get-IngestClient).PostAsync($ingestUri, $content).Result
            if (-not $response.IsSuccessStatusCode) {
                $script:forwardErrors++
                if ($script:forwardErrors -le 3 -or $script:forwardErrors % 60 -eq 0) {
                    Log-Error ("ingest HTTP " + [int]$response.StatusCode)
                }
                return
            }
        } else {
            $headers = @{ 'X-Firefly-Board' = 'FIREFLY-SENSE' }
            Invoke-RestMethod -Uri $ingestUri -Method Post -Body ('CSV,' + $Fields) -Headers $headers -TimeoutSec 5 | Out-Null
        }
        $script:forwardErrors = 0
    } catch {
        $script:forwardErrors++
        if ($script:forwardErrors -le 3 -or $script:forwardErrors % 60 -eq 0) {
            Log-Error ('ingest unreachable: ' + $_.Exception.Message)
        }
    }
}

function Write-CsvRow([string]$Fields) {
    $pcTime = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    if ($null -eq $script:writer) {
        $script:writer = [System.IO.StreamWriter]::new(
            $script:OutFile, $false, [System.Text.UTF8Encoding]::new($true))
        $script:writer.AutoFlush = $true
    }
    if ($null -eq $script:liveWriter) {
        $script:liveWriter = [System.IO.StreamWriter]::new(
            $script:LiveFile, $false, [System.Text.UTF8Encoding]::new($false))
        $script:liveWriter.AutoFlush = $true
    }
    $row = $pcTime + ',' + $Fields
    $script:writer.WriteLine($row)
    $script:liveWriter.WriteLine($row)
}

function Write-CsvHeader([string]$Fields) {
    if ($script:headerWritten) {
        return
    }
    if ($null -eq $script:writer) {
        $script:writer = [System.IO.StreamWriter]::new(
            $script:OutFile, $false, [System.Text.UTF8Encoding]::new($true))
        $script:writer.AutoFlush = $true
    }
    if ($null -eq $script:liveWriter) {
        $script:liveWriter = [System.IO.StreamWriter]::new(
            $script:LiveFile, $false, [System.Text.UTF8Encoding]::new($false))
        $script:liveWriter.AutoFlush = $true
    }
    $header = 'pc_time,' + $Fields
    $script:writer.WriteLine($header)
    $script:writer.Flush()
    $script:liveWriter.WriteLine($header)
    $script:headerWritten = $true
}

function Handle-Connection($Client) {
    $stream = $Client.GetStream()
    $stream.ReadTimeout = 5000
    $socket = $Client.Client
    # leaveOpen=$true：Dispose 只冲缓冲，不关共享的 NetworkStream。
    $writer = [System.IO.StreamWriter]::new(
        $stream, [System.Text.UTF8Encoding]::new($false), 1024, $true)
    $writer.AutoFlush = $true
    # 逐字节拼行（不用 StreamReader 预读缓冲，避免突发多行被缓冲吞掉后
    # DataAvailable 误判为空闲，导致 PONG 等应答被推迟到下一次到达）。
    $lineBuf = New-Object 'System.Collections.Generic.List[byte]'
    $sawHello = $false
    $lastDataAt = [DateTime]::Now

    :connectionLoop while ($Client.Connected) {
        # FIN：可读且没有未读字节 -> 对端已优雅关闭。
        if ($socket.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and
            $Client.Available -eq 0) {
            break
        }
        # RST：socket 进入错误状态。
        if ($socket.Poll(0, [System.Net.Sockets.SelectMode]::SelectError)) {
            break
        }

        if ($stream.DataAvailable) {
            $chunk = New-Object byte[] 1024
            $read = $stream.Read($chunk, 0, $chunk.Length)
            for ($i = 0; $i -lt $read; $i++) {
                $b = $chunk[$i]
                if ($b -eq 10) {
                    # 完整一行：UTF-8 解码（板端输出为 ASCII），去掉 \r。
                    $raw = [System.Text.Encoding]::UTF8.GetString(
                        $lineBuf.ToArray())
                    $lineBuf.Clear()
                    $line = $raw.TrimEnd([char]13)
                    $lastDataAt = [DateTime]::Now
                    if ($line.Length -eq 0) {
                        continue
                    }

                    if ($line.StartsWith('PING')) {
                        $payload = $line.Substring(4).Trim()
                        $writer.WriteLine('PONG ' + $payload)
                        continue
                    }

                    if ($line.StartsWith('HELLO,')) {
                        $firmwareMetadata = $line.Substring(6).Trim()
                        Log-Info ('Firmware: ' + $firmwareMetadata)
                        $sawHello = $true
                        if ($StartStream) {
                            $writer.WriteLine('MODE 2')
                            Log-Info 'start-stream: sent MODE 2'
                        }
                        continue
                    }

                    if ($line.StartsWith('CSV,')) {
                        $fields = $line.Substring(4)
                        if ($fields.StartsWith('uptime_ms,')) {
                            # 固件自带表头：只落盘一次，不转发。
                            Write-CsvHeader $fields
                            continue
                        }
                        Write-CsvRow $fields
                        if (-not $NoFlitFancy) {
                            Forward-Line $fields
                        }
                        continue
                    }

                    # 其他行：当作板端调试输出，仅打印。
                    Log-Info ('board: ' + $line)
                } else {
                    if ($lineBuf.Count -ge 4096) {
                        $lineBuf.Clear()   # 防异常长行无限增长
                    }
                    $lineBuf.Add($b)
                }
            }
            continue connectionLoop
        }

        # 空闲保护：
        # - HELLO 前（健康探测等）：按 -TimeoutSeconds（0 = 不限）；
        # - HELLO 后（真板子）：固件每 3 s 必发 PING，30 s 无任何数据
        #   即链路已死（板断电/WiFi 掉线后的半开连接没有 FIN/RST）。
        #   关闭并回到 accept，绝不让一条静默连接把监听器卡死。
        $idleLimit = if ($sawHello) { 30 } else { $TimeoutSeconds }
        if ($idleLimit -gt 0 -and
            (([DateTime]::Now - $lastDataAt).TotalSeconds -ge $idleLimit)) {
            if ($sawHello) {
                Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') +
                    '] board link idle; closing to accept reconnects')
            } else {
                Log-Info 'idle probe connection closed'
            }
            break
        }
        Start-Sleep -Milliseconds 50
    }

    try { $writer.Dispose() } catch { }   # leaveOpen=$true，不关 socket
    try { $stream.Dispose() } catch { }
    try { $Client.Close() } catch { }
}

$listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Any, $Port)
$listener.Start()
Log-Info ("listening on 0.0.0.0:$Port -> $sessionsRoot (sessions), $LiveFile (live)")

while ($true) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
        $remote = $client.Client.RemoteEndPoint.ToString()
        Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] connected: ' + $remote)
        Handle-Connection $client
        Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] disconnected: ' + $remote)
    } catch {
        if ($null -ne $client) {
            try { $client.Close() } catch { }
        }
        # 连接异常（RST 等）只影响当前连接；继续监听。
        Log-Error ('connection dropped: ' + $_.Exception.Message)
        Start-Sleep -Milliseconds 100
    }
}
