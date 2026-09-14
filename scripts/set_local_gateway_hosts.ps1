param([ValidateSet('Enable', 'Disable')][string]$Mode = 'Enable')

function Update-FlitHostsText {
    param([string]$Text, [bool]$Enable)
    $pattern = '(?ms)^# BEGIN FlitFancy local HTTPS\r?\n.*?^# END FlitFancy local HTTPS(?:\r?\n)?'
    $clean = [regex]::Replace($Text, $pattern, '')
    if (-not $Enable) { return $clean }
    foreach ($line in ($clean -split '\r?\n')) {
        $parts = (($line -split '#', 2)[0].Trim() -split '\s+')
        if ($parts.Count -gt 1 -and $parts[1..($parts.Count - 1)] -contains 'console.flitfancy.com') {
            if ($parts[0] -eq '127.0.0.1') { return $clean }
            throw 'An existing hosts entry for console.flitfancy.com needs review.'
        }
    }
    $newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    if ($clean -and -not $clean.EndsWith("`n")) { $clean += $newline }
    return $clean + '# BEGIN FlitFancy local HTTPS' + $newline +
        '127.0.0.1 console.flitfancy.com' + $newline + '# END FlitFancy local HTTPS' + $newline
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Administrator permission is required to update the Windows hosts file.'
        }
        $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
        # Byte-preserving round trip retains unrelated non-ASCII comments unchanged.
        $encoding = [Text.Encoding]::GetEncoding(28591)
        $before = [IO.File]::ReadAllBytes($hostsPath)
        $text = $encoding.GetString($before)
        $after = Update-FlitHostsText -Text $text -Enable ($Mode -eq 'Enable')
        if ($after -ne $text) {
            $backup = $hostsPath + '.before-flitfancy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            [IO.File]::WriteAllBytes($backup, $before)
            [IO.File]::WriteAllBytes($hostsPath, $encoding.GetBytes($after))
        }
        Clear-DnsClientCache
        Write-Output ('FlitFancy local hosts: ' + $Mode)
        exit 0
    } catch {
        Write-Error $_
        exit 1
    }
}
