# Wait for one launched controller, never its persistent service descendants.
function Wait-LocalHelperProcess {
    param([Parameter(Mandatory=$true)]$Process,
          [ValidateRange(1,300)][int]$TimeoutSeconds = 180,
          [scriptblock]$OnWaiting)
    # Retain the process handle before a short-lived helper can disappear.
    $null = $Process.Handle
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $reported = -1
    while (-not $Process.WaitForExit(500)) {
        $seconds = [int][math]::Floor($clock.Elapsed.TotalSeconds)
        if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            throw 'Timed out waiting for the restart controller. The service may still be starting; check logs/service-restart.log.'
        }
        if ($OnWaiting -and $seconds -ne $reported) { & $OnWaiting $seconds; $reported = $seconds }
    }
    if ($null -eq $Process.ExitCode) { throw 'The restart controller exited without an available result code.' }
    return [int]$Process.ExitCode
}
