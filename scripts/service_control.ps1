# Process inspection and explicit control for the three auxiliary local services.
# Dot-source only. No process is changed while loading this file or inspecting state.
$localServiceScripts = $PSScriptRoot
. (Join-Path $PSScriptRoot 'process_wait.ps1')

function Get-LocalServiceSpec {
    param([ValidateSet('listener', 'audio', 'tunnel')][string]$Service)
    $site = Split-Path -Parent $localServiceScripts
    $root = Split-Path -Parent $site
    $parent = Split-Path -Parent $root
    $logs = Join-Path $root 'logs'
    $spec = @{ Service = $Service; Root = $root; Logs = $logs; Port = 0; PidFiles = @(); Watcher = ''; Exe = ''; App = ''; Config = ''; ListenerPaths = @() }
    switch ($Service) {
        'listener' {
            $spec.Port = 7777
            $spec.Watcher = Join-Path $localServiceScripts 'watch_sensor_listener.ps1'
            $spec.PidFiles = @((Join-Path $logs 'sensor-watchdog.pid'))
            $spec.ListenerPaths = @((Join-Path $localServiceScripts 'vendor\listen_wifi.ps1'),
                (Join-Path $parent 'SkyWorks\FIREFLY REAL-WORLD SENSE\FIREFLY REAL-WORLD SENSE-ds\FIREFLY-SENSE-ds\scripts\listen_wifi.ps1'))
        }
        'audio' {
            $spec.Port = 7865
            $spec.Exe = Join-Path $parent 'Fireflys\Miniconda3\venv\venv_voxcpm\python.exe'
            $spec.App = Join-Path $parent 'NatureCraft\FIREFLY AUDIO\FFV-transfer\app.py'
            $spec.PidFiles = @((Join-Path $logs 'audio.pid'))
        }
        'tunnel' {
            $spec.Watcher = Join-Path $localServiceScripts 'watch_tunnel.ps1'
            $spec.Exe = Join-Path $root 'tools\cloudflared\cloudflared.exe'
            $spec.Config = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
            $spec.PidFiles = @((Join-Path $logs 'tunnel-watchdog.pid'), (Join-Path $logs 'cloudflared.pid'))
        }
    }
    return $spec
}

function Get-ServiceArgument($Command, $Name) {
    $match = [regex]::Match([string]$Command, '(?i)(?:^|\s)' + [regex]::Escape($Name) + '\s+(?:"([^"\r\n]+)"|(\S+))(?=\s|$)')
    if (-not $match.Success) { return '' }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Get-ServiceProcessRole($Spec, $Candidate, [bool]$LegacyAudio = $false) {
    if (-not $Candidate -or -not $Candidate.CommandLine) { return '' }
    $command = $Candidate.CommandLine
    if ($Spec.Service -eq 'audio') {
        if ($Candidate.ExecutablePath -ne $Spec.Exe) { return '' }
        # New launches have an absolute app path. The older relative form also
        # needs the registered PID AND ownership of the audio listening port.
        $scriptArgument = [regex]::Escape($Spec.App)
        if ($LegacyAudio) { $scriptArgument = '(?:' + $scriptArgument + '|app\.py)' }
        $pattern = '^\s*(?:"[^"\r\n]+"|\S+)\s+(?:-u\s+)?(?:-X\s+utf8\s+)?(?:"' + $scriptArgument + '"|' + $scriptArgument + ')\s*$'
        if ($command -match $pattern) { return 'service' }
        return ''
    }
    if ($Spec.Service -eq 'tunnel' -and $Candidate.ExecutablePath -eq $Spec.Exe) {
        if ((Get-ServiceArgument $command '--config') -eq $Spec.Config -and
            ([regex]::Matches($command, '(?i)(?:^|\s)--config\s+')).Count -eq 1 -and
            $command -match '(?:^|\s)tunnel(?:\s+--metrics\s+(?:"[^"]+"|\S+))?\s+run(?:\s|$)') { return 'service' }
        return ''
    }
    if ($Candidate.Name -notmatch '^(powershell|pwsh)\.exe$') { return '' }
    $scriptPath = Get-ServiceArgument $command '-File'
    if ($Spec.Service -eq 'listener') {
        $portValue = Get-ServiceArgument $command '-Port'
        if ($portValue -and $portValue -ne '7777') { return '' }
        if ($scriptPath -eq $Spec.Watcher) {
            $listener = Get-ServiceArgument $command '-ListenerPath'
            if ($Spec.ListenerPaths -contains $listener) { return 'watcher' }
        } elseif ($Spec.ListenerPaths -contains $scriptPath) { return 'service' }
    } elseif ($scriptPath -eq $Spec.Watcher) {
        foreach ($argument in @(@('-Config', $Spec.Config), @('-Exe', $Spec.Exe), @('-WorkDir', $Spec.Root), @('-Logs', $Spec.Logs))) {
            $value = Get-ServiceArgument $command $argument[0]
            if ($value -and $value -ne $argument[1]) { return '' }
        }
        return 'watcher'
    }
    return ''
}

function Get-LocalServiceState {
    param([ValidateSet('listener', 'audio', 'tunnel')][string]$Service)
    $spec = Get-LocalServiceSpec $Service
    $registered = @()
    foreach ($file in $spec.PidFiles) {
        if (Test-Path -LiteralPath $file) {
            $text = (Get-Content -LiteralPath $file -Raw).Trim()
            $number = 0
            if (-not [int]::TryParse($text, [ref]$number) -or $number -le 0) { throw 'Invalid service PID record; no process was changed.' }
            $registered += $number
        }
    }
    $owners = @()
    if ($spec.Port) {
        $owners = @(Get-NetTCPConnection -LocalPort $spec.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    }
    $candidates = @{}
    foreach ($number in @($registered + $owners | Select-Object -Unique)) {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$number"
        if ($candidate) { $candidates[[int]$candidate.ProcessId] = $candidate }
    }
    $filter = if ($Service -eq 'audio') { "Name='python.exe' OR Name='pythonw.exe'" }
        elseif ($Service -eq 'tunnel') { "Name='cloudflared.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" }
        else { "Name='powershell.exe' OR Name='pwsh.exe'" }
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter $filter)) {
        if (Get-ServiceProcessRole $spec $candidate) { $candidates[[int]$candidate.ProcessId] = $candidate }
    }
    $entries = @(
        foreach ($candidate in $candidates.Values) {
            $legacy = $Service -eq 'audio' -and $registered -contains [int]$candidate.ProcessId -and $owners -contains [int]$candidate.ProcessId
            $role = Get-ServiceProcessRole $spec $candidate $legacy
            [pscustomobject]@{ Process = $candidate; Role = $role; Verified = [bool]$role; LegacyAudio = $legacy }
        }
    )
    $unverified = @($entries | Where-Object { -not $_.Verified }).Count -gt 0
    $ambiguous = @($entries | Where-Object Role -eq 'watcher').Count -gt 1 -or @($entries | Where-Object Role -eq 'service').Count -gt 1
    # A port may still be visible when its owner cannot be inspected.
    foreach ($owner in $owners) { if (-not $candidates.ContainsKey([int]$owner)) { $unverified = $true } }
    return [pscustomobject]@{ Running = [bool]($entries.Count -or $owners.Count); Verified = -not ($unverified -or $ambiguous); Processes = $entries; Spec = $spec }
}

function Stop-VerifiedServiceProcess($Spec, $Entry) {
    $expected = $Entry.Process
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $expected.ProcessId)
    if (-not $current) { return }
    if (-not $expected.CreationDate -or $current.CreationDate -ne $expected.CreationDate -or
        (Get-ServiceProcessRole $Spec $current $Entry.LegacyAudio) -ne $Entry.Role) {
        throw 'Service identity changed; refusing to stop this process.'
    }
    Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop
    Wait-Process -Id $current.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $current.ProcessId)
    if ($remaining -and $remaining.CreationDate -eq $current.CreationDate) { throw 'Service did not stop in time.' }
}

function Clear-StaleServiceControllers {
    param([ValidateSet('listener', 'audio', 'tunnel')][string]$Service,
          [datetime]$Now = [datetime]::UtcNow,
          [string]$UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $controller = Join-Path $localServiceScripts 'reload_service.ps1'
    # Old versions could hold the operation mutex forever after their service
    # had already started. Only an explicit NEW restart reaches this recovery.
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'")) {
        if ($candidate.ProcessId -eq $PID -or -not $candidate.CreationDate -or
            ($Now.ToUniversalTime() - $candidate.CreationDate.ToUniversalTime()).TotalSeconds -lt 300 -or
            (Get-ServiceArgument $candidate.CommandLine '-File') -ne $controller -or
            (Get-ServiceArgument $candidate.CommandLine '-Service') -ne $Service -or
            ([regex]::Matches([string]$candidate.CommandLine, '(?i)(?:^|\s)-Service\s+')).Count -ne 1) { continue }
        try { $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid } catch { continue }
        if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $UserSid) { continue }
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $candidate.ProcessId)
        if (-not $current -or $current.CreationDate -ne $candidate.CreationDate -or $current.CommandLine -ne $candidate.CommandLine) { continue }
        # Terminate this obsolete controller only, never its process tree.
        Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop
        Wait-Process -Id $current.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        Write-Output ([int]$current.ProcessId)
    }
}

function Test-LocalServiceReady($Service) {
    $state = Get-LocalServiceState $Service
    if (-not $state.Running -or -not $state.Verified) { return $false }
    if ($Service -eq 'listener') {
        # Never connect to port 7777: the listener treats a new client as a board.
        return @(Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
    }
    if ($Service -eq 'audio') {
        try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:7865/status' -TimeoutSec 2; return $true } catch { return $false }
    }
    foreach ($entry in @($state.Processes | Where-Object Role -eq 'service')) {
        foreach ($port in @(Get-NetTCPConnection -State Listen -OwningProcess $entry.Process.ProcessId -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1')) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ('http://127.0.0.1:' + $port.LocalPort + '/ready')
                if ($response.StatusCode -eq 200) { return $true }
            } catch { }
        }
    }
    return $false
}

function Invoke-LocalServiceStart($Service) {
    $state = Get-LocalServiceState $Service
    if ($state.Running) {
        if (-not $state.Verified) { throw 'Existing service identity is unavailable or ambiguous; nothing was stopped or started.' }
    } else {
        # A native pipeline can retain a persistent grandchild's inherited handles.
        # Launch a hidden command process and wait only for that exact process.
        $arguments = '/d /c ""' + (Join-Path $localServiceScripts 'start_flitfancy.bat') + '" ' + $Service + '"'
        $starter = Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $localServiceScripts -WindowStyle Hidden -PassThru
        try {
            if ((Wait-LocalHelperProcess -Process $starter -TimeoutSeconds 90) -ne 0) { throw 'Service starter failed. See logs/starter.log.' }
        } finally { $starter.Dispose() }
    }
    $deadline = [datetime]::UtcNow.AddSeconds(45)
    do {
        if (Test-LocalServiceReady $Service) { return }
        Start-Sleep -Seconds 1
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Service has not become ready. Its process may still be starting; see logs/starter.log.'
}

function Invoke-LocalServiceOperation {
    param([ValidateSet('listener', 'audio', 'tunnel')][string]$Service, [switch]$Restart)
    $mutex = New-Object Threading.Mutex($false, ('Global\FlitFancyServiceControl-' + $Service))
    $owns = $false
    $pauseFile = $null
    $pauseToken = 'Local manual restart ' + [guid]::NewGuid().ToString('N')
    try {
        try { $owns = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $owns = $true }
        if (-not $owns) { throw 'Another service operation is still running.' }
        if ($Restart) {
            $state = Get-LocalServiceState $Service
            if (-not $state.Verified) { throw 'Service process cannot be verified; nothing was stopped.' }
            if ($Service -eq 'tunnel') {
                [IO.Directory]::CreateDirectory($state.Spec.Logs) | Out-Null
                $pauseFile = Join-Path $state.Spec.Logs 'tunnel-watchdog.paused'
                [IO.File]::WriteAllText($pauseFile, $pauseToken)
            }
            foreach ($entry in @($state.Processes | Where-Object Role -eq 'watcher')) { Stop-VerifiedServiceProcess $state.Spec $entry }
            # Reinspect after stopping the watcher: it may have just spawned a replacement.
            $state = Get-LocalServiceState $Service
            if (-not $state.Verified) { throw 'Service identity changed during restart; no further processes stopped.' }
            foreach ($entry in $state.Processes) { Stop-VerifiedServiceProcess $state.Spec $entry }
            # Remove only stale PID records; never a record belonging to a live process.
            foreach ($file in $state.Spec.PidFiles) {
                if (Test-Path -LiteralPath $file) {
                    $number = (Get-Content -LiteralPath $file -Raw).Trim()
                    if ($number -match '^\d+$' -and -not (Get-CimInstance Win32_Process -Filter "ProcessId=$number")) { Remove-Item -LiteralPath $file -Force }
                }
            }
        }
        Invoke-LocalServiceStart $Service
    } finally {
        if ($pauseFile -and (Test-Path -LiteralPath $pauseFile) -and (Get-Content -LiteralPath $pauseFile -Raw) -eq $pauseToken) { Remove-Item -LiteralPath $pauseFile -Force -ErrorAction SilentlyContinue }
        if ($owns) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
