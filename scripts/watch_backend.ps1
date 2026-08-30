param(
    [Parameter(Mandatory = $true)]
    [string]$ServerPath,        # server.py
    [Parameter(Mandatory = $true)]
    [string]$Exe,               # python 可执行文件
    [Parameter(Mandatory = $true)]
    [string]$WorkDir,           # backend 目录
    [string]$OutLog = '',
    [string]$ErrLog = '',
    [string]$PidFile = '',      # 后端进程 pid 文件（沿用 bat 的 backend.pid 约定）
    [string]$Url = 'http://127.0.0.1:2671/api/status',
    [int]$HealthIntervalSeconds = 30,
    [int]$InitialRestartDelaySeconds = 5,
    [int]$MaximumRestartDelaySeconds = 60
)

# 后端自守护（2026-08-30）
#
# 背景：后端进程曾多次"静默死亡"（日志里没有任何崩溃记录，疑似外部强杀），
# 控制台因此整页失联。本脚本提供与 watch_sensor_listener.ps1 相同语义的守护：
#   - 每 HealthIntervalSeconds 探测一次 /api/status；
#   - 不健康 → 杀掉残留进程（按 pid 文件）→ 重新拉起 server.py → 等待就绪；
#   - 快速连续失败时退避（5s → 60s），稳定后回到初始间隔；
#   - 单实例保护（backend-watchdog.pid），由 start_flitfancy.bat 幂等启动。

$ErrorActionPreference = 'Stop'

$logsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'logs'
if (-not $OutLog) { $OutLog = Join-Path $logsRoot 'server.out.log' }
if (-not $ErrLog) { $ErrLog = Join-Path $logsRoot 'server.err.log' }
if (-not $PidFile) { $PidFile = Join-Path $logsRoot 'backend.pid' }

# --- 单实例保护：PID 文件 + 存活校验，防止重复 watchdog 叠堆 ---
$myPidFile = Join-Path $logsRoot 'backend-watchdog.pid'
if (Test-Path -LiteralPath $myPidFile) {
    $existingText = Get-Content -LiteralPath $myPidFile -Raw -ErrorAction SilentlyContinue
    if ($existingText -match '^\s*(\d+)\s*$') {
        $existingPid = [int]$Matches[1]
        if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
            Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Another backend watchdog is already running (PID $existingPid); this instance exits."
            exit 0
        }
    }
}
[System.IO.Directory]::CreateDirectory($logsRoot) | Out-Null
[System.IO.File]::WriteAllText($myPidFile, [string]$PID)

function Test-BackendHealthy {
    try {
        $resp = Invoke-RestMethod -Uri $Url -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Start-Backend {
    if (Test-Path -LiteralPath $PidFile) {
        $old = Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue
        if ($old -match '^\s*(\d+)\s*$') {
            $oldPid = [int]$Matches[1]
            if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 1
            }
        }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
    $proc = Start-Process -FilePath $Exe -ArgumentList $ServerPath -WorkingDirectory $WorkDir -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
    if ($PidFile) {
        [System.IO.File]::WriteAllText($PidFile, [string]$proc.Id)
    }
    return $proc
}

$restartDelaySeconds = $InitialRestartDelaySeconds
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Backend watchdog started (health every $HealthIntervalSeconds s)."

try {
    while ($true) {
        if (Test-BackendHealthy) {
            $restartDelaySeconds = $InitialRestartDelaySeconds
            Start-Sleep -Seconds $HealthIntervalSeconds
            continue
        }
        Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Backend unhealthy; restarting."
        $proc = Start-Backend
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $healthy = $false
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-BackendHealthy) { $healthy = $true; break }
            Start-Sleep -Seconds 1
        }
        if ($healthy) {
            Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Backend healthy (pid $($proc.Id))."
            $restartDelaySeconds = $InitialRestartDelaySeconds
        } else {
            Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Backend still down; backoff $restartDelaySeconds s."
            Start-Sleep -Seconds $restartDelaySeconds
            $restartDelaySeconds = [Math]::Min($MaximumRestartDelaySeconds, $restartDelaySeconds * 2)
        }
    }
} finally {
    $mine = Get-Content -LiteralPath $myPidFile -Raw -ErrorAction SilentlyContinue
    if ($mine -match ('^\s*' + $PID + '\s*$')) {
        Remove-Item -LiteralPath $myPidFile -Force -ErrorAction SilentlyContinue
    }
}
