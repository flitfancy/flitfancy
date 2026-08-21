param(
    [switch]$Uninstall
)

# ============================================================
#  注册 / 移除 flitfancy-<随机8位>:// 自定义协议（用户级，无需管理员）
#  协议名随机：任意网页猜不到协议名，无法静默触发启动器。
#  随机名写入 HKCU:\Software\FlitFancy\ProtocolName，本地后端经
#  /api/status 的 protocol_name 字段注入控制台，"启动 FFS"按钮自动使用。
#  协议命令直接指向 PowerShell 白名单处理器（start_flitfancy.ps1），
#  不经过任何 cmd 字符串拼接，恶意 URL 无法注入命令。
# ============================================================

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath   # site\scripts
$batPath = Join-Path $scriptDir 'start_flitfancy.bat'
$ps1Path = Join-Path $scriptDir 'start_flitfancy.ps1'
$appKey = 'HKCU:\Software\FlitFancy'
$classes = 'HKCU:\Software\Classes'

function Get-InstalledProtocol {
    $name = $null
    if (Test-Path $appKey) {
        $name = (Get-ItemProperty -Path $appKey -Name ProtocolName -ErrorAction SilentlyContinue).ProtocolName
    }
    if ($name) { return $name }
    return 'flitfancy'
}

if ($Uninstall) {
    $name = Get-InstalledProtocol
    foreach ($candidate in @($name, 'flitfancy')) {
        $keyPath = Join-Path $classes $candidate
        if (Test-Path $keyPath) {
            Remove-Item -Path $keyPath -Recurse -Force
            Write-Host ("已移除 " + $candidate + ":// 协议注册。")
        }
    }
    if (Test-Path $appKey) {
        Remove-ItemProperty -Path $appKey -Name ProtocolName -ErrorAction SilentlyContinue
    }
    Write-Host '协议已卸载。'
    exit 0
}

if (-not (Test-Path -LiteralPath $batPath)) { throw "找不到启动脚本：$batPath" }
if (-not (Test-Path -LiteralPath $ps1Path)) { throw "找不到协议处理器：$ps1Path" }

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$protocol = 'flitfancy-' + $suffix
$keyPath = Join-Path $classes $protocol

# 清理旧固定名注册，避免留下可被猜中的旧入口
$legacyKey = Join-Path $classes 'flitfancy'
if (Test-Path $legacyKey) { Remove-Item -Path $legacyKey -Recurse -Force }

New-Item -Path $keyPath -Value 'URL:FlitFancy Protocol' -Force | Out-Null
New-ItemProperty -Path $keyPath -Name 'URL Protocol' -PropertyType String -Value '' -Force | Out-Null
New-Item -Path (Join-Path $keyPath 'shell\open\command') -Force | Out-Null
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $ps1Path + '" "%1"'
Set-ItemProperty -Path (Join-Path $keyPath 'shell\open\command') -Name '(default)' -Value $command

New-Item -Path $appKey -Force | Out-Null
New-ItemProperty -Path $appKey -Name ProtocolName -PropertyType String -Value $protocol -Force | Out-Null

Write-Host ("已注册 " + $protocol + "://start -> " + $ps1Path)
Write-Host '控制台点"启动 FFS"即可（首次使用浏览器会弹确认框，选允许）。'
