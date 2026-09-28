# Interactive backend entry for the existing browser protocol. Dot-source for tests.
$backendScripts = $PSScriptRoot
. (Join-Path $PSScriptRoot 'process_wait.ps1')

function Get-BackendWindowState {
    $site = Split-Path -Parent $backendScripts
    $pidFile = Join-Path (Split-Path -Parent $site) 'logs\backend.pid'
    $server = Join-Path $site 'backend\server.py'
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 2671 -ErrorAction SilentlyContinue)
    $process = $null
    if (Test-Path -LiteralPath $pidFile) {
        $text = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        $number = 0
        if (-not [int]::TryParse($text, [ref]$number) -or $number -le 0) {
            throw 'Invalid backend PID file; no process was changed.'
        }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$number"
    }
    $escapedServer = [regex]::Escape($server)
    $verified = $process -and $process.Name -match '^python(w)?(\.exe)?$' -and
        $process.CommandLine -match ('(?i)(?:^|\s)(?:"' + $escapedServer + '"|' + $escapedServer + ')(?=\s|$)')
    if ($process -and @($listeners | Where-Object { $_.OwningProcess -ne $process.ProcessId }).Count) {
        $verified = $false
    }
    return [pscustomobject]@{
        Running = [bool]($process -or $listeners.Count)
        Verified = [bool]$verified
        ProcessId = $(if ($process) { $process.ProcessId } else { 0 })
    }
}

function Read-BackendWindowKey {
    try {
        if ([Console]::KeyAvailable) { return [Console]::ReadKey($true).Key.ToString() }
    } catch { return 'Escape' }
    return ''
}

function Show-BackendWindowFrame($Selected, $Seconds, $AllowRestart) {
    $choices = if ($AllowRestart) {
        if ($Selected -eq 'restart') { '  关闭窗口    > 重启后端' } else { '> 关闭窗口      重启后端' }
    } else { '> 关闭窗口' }
    $hint = if ($Seconds -ge 0) { "$Seconds 秒后关闭窗口" } else { '倒计时已暂停，回车确认 / Esc 关闭' }
    $width = [Console]::WindowWidth
    if ($width -le 0) { $width = 80 }
    # Clear the old countdown without padding a wide Chinese line past the edge.
    Write-Host ("`r" + (' ' * ($width - 1)) + "`r" + $choices + '  |  ' + $hint) -NoNewline
}

function Read-BackendWindowAction {
    param([switch]$AllowRestart,
          [scriptblock]$ReadKey = { Read-BackendWindowKey },
          [scriptblock]$Now = { [datetime]::UtcNow },
          [scriptblock]$Sleep = { Start-Sleep -Milliseconds 100 },
          [scriptblock]$Render = { param($Selected, $Seconds, $CanRestart) Show-BackendWindowFrame $Selected $Seconds $CanRestart })
    $deadline = (& $Now).AddSeconds(15)
    $selected = 'close'
    $interacting = $false
    while ($true) {
        $remaining = [int][Math]::Ceiling(($deadline - (& $Now)).TotalSeconds)
        if (-not $interacting -and $remaining -le 0) { return 'close' }
        $displaySeconds = if ($interacting) { -1 } else { $remaining }
        & $Render $selected $displaySeconds ([bool]$AllowRestart)
        $key = & $ReadKey
        switch ($key) {
            'DownArrow' { if ($AllowRestart) { $selected = 'restart'; $interacting = $true } }
            'UpArrow' { $selected = 'close'; $interacting = $true }
            'Enter' { return $selected }
            'Escape' { return 'close' }
        }
        & $Sleep
    }
}

function Start-BackendFromWindow {
    Push-Location $backendScripts
    try { & cmd.exe /c call start_flitfancy.bat backend | Out-Host }
    finally { Pop-Location }
    $deadline = [datetime]::UtcNow.AddSeconds(40)
    do {
        try {
            $null = Invoke-RestMethod -Uri 'http://127.0.0.1:2671/api/status' -TimeoutSec 2
            return
        } catch { Start-Sleep -Seconds 1 }
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Backend did not become ready. See logs/starter.log.'
}

function Restart-BackendFromWindow {
    # Only a local arrow + Enter selection reaches this function. The protocol
    # never accepts a restart action, path, command or elevation flag from a URL.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $launch = @{
        FilePath = (Join-Path $PSHOME 'powershell.exe')
        ArgumentList = ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $backendScripts 'reload_backend.ps1') + '"')
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $launch.Verb = 'RunAs' }
    $result = Start-Process @launch
    try {
        $exitCode = Wait-LocalHelperProcess -Process $result -OnWaiting {
            param($Seconds)
            Write-Host ("`r正在等待后端重启完成… 已等待 $Seconds 秒   ") -NoNewline
        }
        Write-Host ''
        if ($exitCode -ne 0) { throw 'Restart failed: process identity, permissions or startup checks did not pass. Run scripts/reload_backend.ps1 in an Administrator terminal for details.' }
    } finally { $result.Dispose() }
}

function Invoke-BackendWindow {
    $code = 0
    try {
        $state = Get-BackendWindowState
        if (-not $state.Running) {
            Write-Host '后端未运行，正在启动…'
            Start-BackendFromWindow
            Write-Host '后端已就绪。关闭此窗口不影响服务。'
        } else {
            Write-Host '检测到后端进程或端口正在使用，保持当前服务运行。'
        }
        Write-Host '按 ↓ 选择重启，回车执行；↑ 返回关闭，Esc 退出。'
        Write-Host '重启会中断正在上传的文件，并需要重新登录网页。'
        $action = Read-BackendWindowAction -AllowRestart
        Write-Host ''
        if ($action -eq 'restart') {
            Write-Host '正在重启后端；如弹出 Windows 权限提示，请确认。'
            Restart-BackendFromWindow
            Write-Host '后端已重启，请刷新网页并重新登录。'
            $null = Read-BackendWindowAction
            Write-Host ''
        }
    } catch {
        $code = 1
        Write-Host ("操作未完成：" + $_.Exception.Message) -ForegroundColor Red
        $null = Read-BackendWindowAction
        Write-Host ''
    }
    return $code
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    exit (Invoke-BackendWindow)
}
