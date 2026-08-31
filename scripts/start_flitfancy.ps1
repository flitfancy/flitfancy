param(
    [string]$Url = ''
)

# ============================================================
#  协议处理器：flitfancy-<随机>://start/<动作>（旧固定名注册已废弃）
#  动作白名单：backend | listener | tunnel | all
#  安全约定：URL 只经正则白名单校验；通过后仅把字面量动作传给 bat，
#            绝不把 URL 原文写进日志或拼进任何命令。
#            PowerShell 的 -File 参数绑定不解析命令语义，
#            任意恶意输入（引号/&/|）只会导致校验失败被忽略。
# ============================================================

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath

if ($Url -isnot [string]) { $Url = [string]$Url }
$match = [regex]::Match($Url, '^[A-Za-z0-9_-]+://start/(backend|listener|tunnel|all)$')
if (-not $match.Success) {
    Write-Host '协议请求未通过白名单校验，已忽略。'
    exit 0
}
$action = $match.Groups[1].Value

Push-Location $scriptDir
try {
    & cmd.exe /c call start_flitfancy.bat $action
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

# 协议点击的窗口不再是"一闪而过"：显示结果并停留 15 秒，
# 期间按任意键立即关闭；关窗/超时都不影响已启动的服务。
Write-Host ''
if ($code -eq 0) {
    Write-Host 'Done. This window closes in 15 seconds (press any key to close now).'
} else {
    Write-Host "Finished with exit code $code. See logs\\starter.log. This window closes in 15 seconds."
}
$deadline = [DateTime]::UtcNow.AddSeconds(15)
try {
    while ([DateTime]::UtcNow -lt $deadline) {
        if ([Console]::KeyAvailable) {
            [Console]::ReadKey($true) | Out-Null
            break
        }
        Start-Sleep -Milliseconds 200
    }
} catch {
    # 控制台输入不可用（重定向等）：直接关闭
}
exit $code
