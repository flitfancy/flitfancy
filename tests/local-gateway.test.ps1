$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\set_local_gateway_hosts.ps1')
$original = "# existing comments`r`n127.0.0.1 localhost`r`n192.168.1.2 unrelated.test`r`n"
$enabled = Update-FlitHostsText $original $true
if (-not $enabled.StartsWith($original)) { throw 'Unrelated hosts entries changed' }
if ((Update-FlitHostsText $enabled $true) -ne $enabled) { throw 'Enable must be idempotent' }
if ((Update-FlitHostsText $enabled $false) -ne $original) { throw 'Disable must remove only the managed block' }
$conflict = $false
try { Update-FlitHostsText "192.168.1.9 console.flitfancy.com`n" $true | Out-Null }
catch { $conflict = $true }
if (-not $conflict) { throw 'Existing conflicting domain entry was silently replaced' }
$preexisting = "127.0.0.1 console.flitfancy.com`n"
if ((Update-FlitHostsText $preexisting $true) -ne $preexisting) { throw 'Existing local mapping duplicated' }
if ((Update-FlitHostsText $preexisting $false) -ne $preexisting) { throw 'Unmanaged mapping was deleted' }
Write-Output 'Local gateway hosts tests passed'
