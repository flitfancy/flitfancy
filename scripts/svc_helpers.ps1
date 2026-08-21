# flitfancy service helpers.
# Extracted from start_flitfancy.bat's inline PowerShell one-liners so that
# quoting lives in one file instead of nine fragile cmd lines.
# Every action exits 0 (success) or 1 (failure); the bat only checks errorlevel.
# Callers pass literal values only (the bat validates its own inputs).

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('is-alive', 'backend-health', 'backend-stale-kill', 'stop-process',
        'start-backend', 'wait-backend', 'listener-health', 'start-watchdog',
        'start-tunnel')]
    [string]$Action,
    # NOTE: not $Pid -- that collides with PowerShell's read-only automatic $PID.
    [string]$ProcessId = '',
    [string]$Exe = '',
    [string]$WorkDir = '',
    [string]$OutLog = '',
    [string]$ErrLog = '',
    [string]$PidFile = '',
    [string]$Config = '',
    [string]$Watchdog = '',
    [string]$Listener = '',
    [string]$DataRoot = '',
    [int]$Port = 0,
    [string]$Url = 'http://127.0.0.1:2671/api/status'
)

function Test-ProcessById {
    param([string]$Id)
    if (-not $Id -or $Id -notmatch '^\d+$') { return $false }
    return [bool](Get-Process -Id ([int]$Id) -ErrorAction SilentlyContinue)
}

function Test-Status {
    param([string]$Target, [int]$TimeoutSec = 3, [string]$Field = '')
    try {
        $resp = Invoke-RestMethod -Uri $Target -TimeoutSec $TimeoutSec
        if ($Field) { return [bool]($resp.services.$Field) }
        return $true
    } catch {
        return $false
    }
}

switch ($Action) {
    'is-alive' {
        if (Test-ProcessById $ProcessId) { exit 0 } else { exit 1 }
    }
    'backend-health' {
        if (Test-Status $Url) { exit 0 } else { exit 1 }
    }
    'backend-stale-kill' {
        # Healthy -> nothing to do. Unhealthy -> kill whoever holds port 2671.
        if (Test-Status $Url) { exit 0 }
        $conn = Get-NetTCPConnection -LocalPort 2671 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
        exit 1
    }
    'stop-process' {
        if (Test-ProcessById $ProcessId) { Stop-Process -Id ([int]$ProcessId) -Force -ErrorAction SilentlyContinue }
        exit 0
    }
    'start-backend' {
        if (-not $Exe -or -not $WorkDir) { exit 1 }
        $proc = Start-Process -FilePath $Exe -ArgumentList 'server.py' -WorkingDirectory $WorkDir -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
        if ($PidFile) { Set-Content -Path $PidFile -Value $proc.Id }
        exit 0
    }
    'wait-backend' {
        $deadline = (Get-Date).AddSeconds(20)
        do {
            if (Test-Status $Url 1) { exit 0 }
            Start-Sleep -Seconds 1
        } while ((Get-Date) -lt $deadline)
        exit 1
    }
    'listener-health' {
        try {
            $resp = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($resp.services.listener) { exit 0 } else { exit 1 }
        } catch {
            exit 0   # keep original semantics: unknown status is not 'unhealthy'
        }
    }
    'start-watchdog' {
        if (-not $Watchdog -or -not $Listener) { exit 1 }
        # 路径可能含空格（如 "FIREFLY REAL-WORLD SENSE"）：Start-Process 的
        # 数组参数形式不做自动引号（PS 5.1 已知坑），必须手工嵌双引号拼成
        # 单条命令行——与 启动云萤.bat 桌面版同款写法，已在生产验证。
        $q = [char]34
        $argList = "-NoProfile -ExecutionPolicy Bypass -File $q$Watchdog$q -ListenerPath $q$Listener$q -Port $Port -DataRoot $q$DataRoot$q"
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
        exit 0
    }
    'start-tunnel' {
        if (-not $Exe -or -not $Config) { exit 1 }
        $proc = Start-Process -FilePath $Exe -ArgumentList '--config', $Config, 'tunnel', 'run' -WorkingDirectory $WorkDir -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
        if ($PidFile) { Set-Content -Path $PidFile -Value $proc.Id }
        exit 0
    }
}

exit 1
