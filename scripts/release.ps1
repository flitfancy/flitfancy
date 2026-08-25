<#
FlitFancy 发版自动化

用法（在任意目录均可运行）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 `
    -Version 1.3.14 -Message "feat: your change summary" [-DryRun]

流程：工作区干净检查 → 版本号统一(package.json + 全部 ?v=) → 全量检查 →
      暂存格式审计 → 密钥正则扫描 → 提交 → 打标签 → 原子推送 →
      轮询线上版本号(≤14 分钟) → 未上线自动推空提交扳机再等一轮

-DryRun：演练到提交前一步；set-version 产生的文件修改会保留在工作区。
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Message,
  [switch]$DryRun
)
$ErrorActionPreference = 'Continue'   # 原生命令的 stderr 噪音不当作终止错误，关键步骤均有显式退出码检查
$root = Split-Path -Parent $PSScriptRoot

function Step($text) { Write-Host ("==> " + $text) }

# 0) 前置：必须站在 main；列出将纳入本次发布的工作区改动
Set-Location $root
$branch = (git branch --show-current).Trim()
if ($branch -ne 'main') { throw "必须在 main 分支发版（当前：$branch）" }
$pending = @(git status --porcelain)
if ($pending.Count -gt 0) {
  Write-Host '以下工作区改动将随本次发布一并提交（git add -A）：'
  $pending | ForEach-Object { Write-Host ("  " + $_) }
}

# 1) 版本号统一（package.json + 全部 ?v= 引用）
Step "set-version $Version"
node (Join-Path $PSScriptRoot 'set-version.mjs') $Version
if ($LASTEXITCODE -ne 0) { throw 'set-version 失败' }

# 2) 全量检查（前端/Worker/样式/后端冒烟/版本一致性）
Step 'check:all'
Set-Location (Join-Path $root 'cloudflare')
cmd /c "pnpm run check:all"
if ($LASTEXITCODE -ne 0) { throw 'check:all 失败' }

# 3) 暂存 + 格式审计 + 密钥扫描
Set-Location $root
Step 'stage & audit'
git add -A
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw '暂存差异存在格式问题' }
$staged = git diff --cached --no-ext-diff -U0
$added = $staged | Select-String '^\+(?!\+\+\+)'
$hits = $added | Select-String -Pattern '(?i)(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password\s*[:=]|bearer\s+[a-z0-9._-]{12,}|-----BEGIN .*PRIVATE KEY-----)' |
  Where-Object { $_.Line -notmatch 'Select-String -Pattern' -and
                 $_.Line -notmatch 'test-password|smoke-password' }   # 后两者=扫描器自匹配与测试假令牌
if ($hits) {
  $hits | ForEach-Object { Write-Host ("密钥模式命中: " + $_.Line.Trim()) }
  throw '暂存内容命中密钥模式，禁止提交'
}
Write-Host 'secret scan: 0 hits'

if ($DryRun) {
  git reset | Out-Null
  Step 'DryRun 结束：未提交/未推送；set-version 的文件修改已保留在工作区'
  return
}

# 4) 提交 + 标签 + 原子推送（TLS 瞬断自动重试一次）
Step "commit & tag v$Version"
git commit -m $Message
if ($LASTEXITCODE -ne 0) { throw 'commit 失败' }
git tag -a "v$Version" -m "FlitFancy v$Version"
$pushed = $false
foreach ($attempt in 1..2) {
  git push --atomic origin main "v$Version" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
  if ($attempt -eq 1) {
    Write-Host 'push 失败（网络瞬断?），5 秒后重试...'
    Start-Sleep -Seconds 5
  }
}
if (-not $pushed) { throw 'push 两轮失败' }
Write-Host 'pushed.'

# 5) 轮询线上版本号；未上线 → 空提交扳机 → 再等一轮
function Wait-Live([int]$minutes) {
  $deadline = (Get-Date).AddMinutes($minutes)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 25
    try {
      $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $html = Invoke-WebRequest -UseBasicParsing -Headers @{ 'Cache-Control' = 'no-cache' } `
        -Uri ("https://flitfancy.com/console.html?chk=$stamp") -TimeoutSec 15
      if ($html.Content -match ('[?&]v=' + [regex]::Escape($Version))) { return $true }
    } catch { }
  }
  return $false
}

Step '等待线上部署...'
if (-not (Wait-Live 14)) {
  Write-Host '构建疑似被跳过：推空提交扳机并再等一轮...'
  git commit --allow-empty -m "ci: retrigger pages deploy for v$Version"
  git push origin main 2>$null | Out-Null
  if (-not (Wait-Live 14)) { throw '两轮等待后仍未上线，请到 GitHub Actions / Pages 后台人工排查' }
}
Write-Host ("DONE: v$Version 已上线 ✅")
