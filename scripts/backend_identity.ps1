# Pure identity checks shared by the backend starter and watchdog.
function Test-BackendScriptProcess {
    param($Candidate, [string]$ScriptPath, [switch]$Watchdog)
    if (-not $Candidate -or -not $Candidate.CommandLine) { return $false }
    $scriptPattern = [regex]::Escape($ScriptPath)
    if ($Watchdog) {
        return $Candidate.Name -match '^(powershell|pwsh)\.exe$' -and
            ([regex]::Matches($Candidate.CommandLine, '(?i)(?:^|\s)-File\s+')).Count -eq 1 -and
            $Candidate.CommandLine -match ('(?i)(?:^|\s)-File\s+(?:"' + $scriptPattern + '"|' + $scriptPattern + ')(?=\s|$)')
    }
    return $Candidate.Name -match '^python(w)?\.exe$' -and
        $Candidate.CommandLine -match ('(?i)^\s*(?:"[^"\r\n]+"|\S+)\s+(?:-u\s+)?(?:"' + $scriptPattern + '"|' + $scriptPattern + ')\s*$')
}

function Test-UnreadableBackendWatchdog {
    param($Candidate)
    return $Candidate -and $Candidate.Name -match '^(powershell|pwsh)\.exe$' -and -not $Candidate.CommandLine
}
