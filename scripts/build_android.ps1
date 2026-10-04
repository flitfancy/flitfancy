param([switch]$Check, [switch]$Debug)
$ErrorActionPreference = 'Stop'
$site = Split-Path -Parent $PSScriptRoot
$toolchainFile = Join-Path (Split-Path -Parent $site) 'tools\android-build\toolchain.json'
if (-not (Test-Path -LiteralPath $toolchainFile)) {
    & py -3 (Join-Path $PSScriptRoot 'setup_android.py')
    if ($LASTEXITCODE -ne 0) { throw 'Android toolchain setup failed.' }
}
$toolchain = Get-Content -LiteralPath $toolchainFile -Raw | ConvertFrom-Json
$env:JAVA_HOME = $toolchain.java_home
$env:ANDROID_HOME = $toolchain.sdk
$env:GRADLE_USER_HOME = Join-Path (Split-Path -Parent $toolchain.sdk) 'gradle-cache'
[IO.File]::WriteAllText((Join-Path $site 'android\local.properties'), ('sdk.dir=' + $toolchain.sdk.Replace('\','/').Replace(':','\:') + "`n"), [Text.UTF8Encoding]::new($false))
$tasks = if ($Debug) { @(':app:assembleDebug') } else { @(':app:assembleRelease') }
if ($Check) { $tasks = @(':app:testDebugUnitTest',':app:lintDebug') + $tasks }
if (-not $Debug) {
    $cfg = if (Test-Path -LiteralPath (Join-Path $site 'backend\ai_local.json')) { Get-Content -LiteralPath (Join-Path $site 'backend\ai_local.json') -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if (-not $cfg.android_signing) {
        & py -3 (Join-Path $PSScriptRoot 'init_android_signing.py')
        if ($LASTEXITCODE -ne 0) { throw 'Android signing initialization failed.' }
        $cfg = Get-Content -LiteralPath (Join-Path $site 'backend\ai_local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $env:FLIT_ANDROID_KEYSTORE = $cfg.android_signing.keystore
    $env:FLIT_ANDROID_STORE_PASSWORD = $cfg.android_signing.store_password
}
try {
    & $toolchain.gradle -p (Join-Path $site 'android') --no-daemon @tasks
    if ($LASTEXITCODE -ne 0) { throw 'Android build/check failed.' }
} finally { Remove-Item Env:FLIT_ANDROID_KEYSTORE,Env:FLIT_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue }
