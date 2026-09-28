param([ValidateSet('backend', 'listener', 'audio', 'tunnel')][string]$Service = 'backend')
. (Join-Path $PSScriptRoot 'backend_window.ps1')
. (Join-Path $PSScriptRoot 'service_control.ps1')

function Get-ServiceWindowLabel($Service) {
    return @{ backend = '后端'; listener = '感知'; audio = '音频'; tunnel = '隧道' }[$Service]
}
function Show-ServiceWindowFrame($Service, $Selected, $Seconds, $AllowRestart) {
    $label = Get-ServiceWindowLabel $Service
    $choices = if ($AllowRestart) {
        if ($Selected -eq 'restart') { "  关闭窗口    > 重启$label" } else { "> 关闭窗口      重启$label" }
    } else { '> 关闭窗口' }
    $hint = if ($Seconds -ge 0) { "$Seconds 秒后关闭窗口" } else { '倒计时已暂停，回车确认 / Esc 关闭' }
    $width = [Console]::WindowWidth
    if ($width -le 0) { $width = 80 }
    Write-Host ("`r" + (' ' * ($width - 1)) + "`r" + $choices + '  |  ' + $hint) -NoNewline
}
function Read-ServiceWindowAction($Service, [switch]$AllowRestart) {
    # One shared keyboard/countdown state machine for all four service menus.
    return Read-BackendWindowAction -AllowRestart:$AllowRestart -Render {
        param($Selected, $Seconds, $CanRestart)
        Show-ServiceWindowFrame $Service $Selected $Seconds $CanRestart
    }
}
function Restart-ServiceFromWindow {
    param([ValidateSet('listener', 'audio', 'tunnel')][string]$Service)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $launch = @{
        FilePath = (Join-Path $PSHOME 'powershell.exe')
        ArgumentList = ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $localServiceScripts 'reload_service.ps1') + '" -Service ' + $Service)
        WindowStyle = 'Hidden'; PassThru = $true
    }
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $launch.Verb = 'RunAs' }
    $result = Start-Process @launch
    $label = Get-ServiceWindowLabel $Service
    try {
        $exitCode = Wait-LocalHelperProcess -Process $result -OnWaiting {
            param($Seconds)
            Write-Host ("`r正在等待${label}重启完成… 已等待 $Seconds 秒   ") -NoNewline
        }
        Write-Host ''
        if ($exitCode -ne 0) { throw 'Restart did not complete. See logs/service-restart.log.' }
    } finally { $result.Dispose() }
}
function Invoke-ServiceWindow {
    param([ValidateSet('backend', 'listener', 'audio', 'tunnel')][string]$Service)
    if ($Service -eq 'backend') { return Invoke-BackendWindow }
    $label = Get-ServiceWindowLabel $Service
    $code = 0
    try {
        try {
            $state = Get-LocalServiceState $Service
            if (-not $state.Running) {
                Write-Host "${label}未运行，正在启动…"
                Invoke-LocalServiceOperation $Service
                Write-Host "${label}已就绪。关闭此窗口不影响服务。"
            } else {
                Write-Host "检测到${label}相关进程或端口正在使用，保持当前服务运行。"
                if (-not $state.Verified) { Write-Host '当前窗口无权确认完整进程身份；手动重启时会重新验证。' }
            }
        } catch {
            $code = 1
            Write-Host ('启动未完成：' + $_.Exception.Message) -ForegroundColor Red
        }
        $impact = @{listener='重启会短暂断开感知板连接，随后等待设备重新连接。'; audio='重启会中断音频播放、录音和当前对话。'; tunnel='重启会短暂中断网站的外网访问。'}[$Service]
        Write-Host '按 ↓ 选择重启，回车执行；↑ 返回关闭，Esc 退出。'
        Write-Host $impact
        $action = Read-ServiceWindowAction $Service -AllowRestart
        Write-Host ''
        if ($action -eq 'restart') {
            Write-Host "正在重启${label}；如弹出 Windows 权限提示，请确认。"
            Restart-ServiceFromWindow $Service
            $code = 0
            Write-Host "${label}已重启。"
            $null = Read-ServiceWindowAction $Service
            Write-Host ''
        }
    } catch {
        $code = 1
        Write-Host ('操作未完成：' + $_.Exception.Message) -ForegroundColor Red
        $null = Read-ServiceWindowAction $Service
        Write-Host ''
    }
    return $code
}
if ($MyInvocation.InvocationName -ne '.') { exit (Invoke-ServiceWindow $Service) }
