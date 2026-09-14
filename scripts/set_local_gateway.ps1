param([ValidateSet('Enable', 'Disable')][string]$Mode = 'Enable')
$ErrorActionPreference = 'Stop'
$domain = 'console.flitfancy.com'
$hostsScript = Join-Path $PSScriptRoot 'set_local_gateway_hosts.ps1'
$flitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$statePath = Join-Path $flitRoot 'logs\local-gateway-route.json'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$settings = Get-ItemProperty $key
$entries = @(([string]$settings.ProxyOverride -split ';') | Where-Object { $_ })
$routeState = if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} else { [pscustomobject]@{ proxyEntryAdded = -not ($entries -contains $domain) } }

if ($Mode -eq 'Enable') {
    & (Join-Path $PSScriptRoot 'start_local_gateway.ps1')
    # Validate the real hostname and public trust chain before changing resolution.
    & curl.exe --silent --show-error --fail --noproxy '*' --resolve "${domain}:443:127.0.0.1" `
        "https://$domain/console.html" --output NUL --max-time 10
    if ($LASTEXITCODE -ne 0) { throw 'Local HTTPS validation failed; routing was not changed.' }
    $routeState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $hostsScript + '" -Mode ' + $Mode
$elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
if ($elevated.ExitCode -ne 0) { throw 'Hosts update was not completed; proxy settings were not changed.' }

$settings = Get-ItemProperty $key
$entries = @(([string]$settings.ProxyOverride -split ';') | Where-Object { $_ })
if ($Mode -eq 'Enable' -and -not ($entries -contains $domain)) { $entries += $domain }
if ($Mode -eq 'Disable' -and $routeState.proxyEntryAdded) {
    $entries = @($entries | Where-Object { $_ -ne $domain })
}
Set-ItemProperty $key -Name ProxyOverride -Value ($entries -join ';')

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FlitProxyRefresh {
    [DllImport("wininet.dll", SetLastError=true)]
    public static extern bool InternetSetOption(IntPtr handle, int option, IntPtr buffer, int length);
}
'@
[FlitProxyRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[FlitProxyRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
Write-Output ('Local HTTPS routing: ' + $Mode)
