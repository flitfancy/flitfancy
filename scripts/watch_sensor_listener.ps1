param(
    [Parameter(Mandatory = $true)]
    [string]$ListenerPath,
    [int]$Port = 7777,
    [string]$DataRoot = '',
    [int]$InitialRestartDelaySeconds = 5,
    [int]$MaximumRestartDelaySeconds = 30
)

$ErrorActionPreference = 'Stop'

if (-not $DataRoot) {
    # 默认数据目录由脚本位置推导（scripts/ 的上一级 data\sensors），不依赖盘符。
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $DataRoot = Join-Path $repoRoot 'data\sensors'
}

if (-not (Test-Path -LiteralPath $ListenerPath -PathType Leaf)) {
    throw "Sensor listener not found: $ListenerPath"
}
if ($InitialRestartDelaySeconds -lt 1) {
    throw 'InitialRestartDelaySeconds must be at least 1.'
}
if ($MaximumRestartDelaySeconds -lt $InitialRestartDelaySeconds) {
    throw 'MaximumRestartDelaySeconds must not be less than InitialRestartDelaySeconds.'
}

$restartDelaySeconds = $InitialRestartDelaySeconds

# --- 单实例保护：PID 文件 + 存活校验，防止重复 watchdog 叠堆占端口 ---
$pidFile = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'logs\sensor-watchdog.pid'
if (Test-Path -LiteralPath $pidFile) {
    $existingText = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
    if ($existingText -match '^\s*(\d+)\s*$') {
        $existingPid = [int]$Matches[1]
        if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
            Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Another sensor watchdog is already running (PID $existingPid); this instance exits."
            exit 0
        }
    }
}
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $pidFile)) | Out-Null
[System.IO.File]::WriteAllText($pidFile, [string]$PID)

try {
while ($true) {
    $waitingLogged = $false
    while (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        if (-not $waitingLogged) {
            Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') TCP :$Port is already owned; watchdog is waiting."
            $waitingLogged = $true
        }
        Start-Sleep -Seconds 5
    }

    $startedAt = [DateTime]::UtcNow
    try {
        Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Starting sensor listener on TCP :$Port."
        & $ListenerPath -Port $Port -DataRoot $DataRoot -Quiet
        Write-Warning 'Sensor listener stopped without an error; it will be restarted.'
    } catch {
        Write-Warning (
            "Sensor listener exited unexpectedly: " + $_.Exception.Message)
    }

    $runtimeSeconds = ([DateTime]::UtcNow - $startedAt).TotalSeconds
    if ($runtimeSeconds -ge 60) {
        $restartDelaySeconds = $InitialRestartDelaySeconds
    } else {
        $restartDelaySeconds = [Math]::Min(
            $MaximumRestartDelaySeconds, $restartDelaySeconds * 2)
    }

    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Restarting in $restartDelaySeconds seconds."
    Start-Sleep -Seconds $restartDelaySeconds
}
} finally {
    # 只删除属于自己的 PID 文件，避免与后继 watchdog 的 pid 文件竞争
    $mine = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
    if ($mine -match ('^\s*' + $PID + '\s*$')) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}
