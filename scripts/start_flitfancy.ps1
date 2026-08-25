param(
    [string]$Url = ''
)

# ============================================================
#  协议处理器：flitfancy-<随机>://start/<动作>（旧固定名注册已废弃）
#  动作白名单：backend | listener | tunnel | dsh | all
#  安全约定：URL 只经正则白名单校验；通过后仅把字面量动作传给 bat，
#            绝不把 URL 原文写进日志或拼进任何命令。
#            PowerShell 的 -File 参数绑定不解析命令语义，
#            任意恶意输入（引号/&/|）只会导致校验失败被忽略。
# ============================================================

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath

if ($Url -isnot [string]) { $Url = [string]$Url }
$match = [regex]::Match($Url, '^[A-Za-z0-9_-]+://start/(backend|listener|tunnel|dsh|all)$')
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
exit $code
