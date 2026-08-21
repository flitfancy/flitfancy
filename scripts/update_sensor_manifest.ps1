param(
    [string]$DataRoot
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DataRoot) {
    $DataRoot = Join-Path $repoRoot 'data\sensors'
}
$manifestPath = Join-Path $DataRoot 'manifest.csv'
$scanRoots = @((Join-Path $DataRoot 'archive'))

$rows = foreach ($scanRoot in $scanRoots) {
    if (-not (Test-Path -LiteralPath $scanRoot)) {
        continue
    }
    foreach ($file in Get-ChildItem -LiteralPath $scanRoot -Recurse -File -Filter '*.csv') {
        try {
            $stream = [System.IO.File]::Open(
                $file.FullName,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite)
            try {
                $reader = [System.IO.StreamReader]::new(
                    $stream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
                try {
                    $header = $reader.ReadLine()
                    $lineCount = if ($null -eq $header) { 0 } else { 1 }
                    while ($null -ne $reader.ReadLine()) {
                        ++$lineCount
                    }
                } finally {
                    $reader.Dispose()
                }
            } finally {
                $stream.Dispose()
            }
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        } catch [System.IO.IOException] {
            Write-Warning "Skipping unreadable archive: $($file.FullName)"
            continue
        }
        $relative = $file.FullName.Substring($DataRoot.Length).TrimStart('\') -replace '\\', '/'
        [pscustomobject]@{
            path = $relative
            bytes = $file.Length
            lines = $lineCount
            header_fields = if ($header) { ($header -split ',').Count } else { 0 }
            sha256 = $hash
        }
    }
}

$rows | Sort-Object path | Export-Csv -LiteralPath $manifestPath -NoTypeInformation -Encoding UTF8
Write-Host "Manifest updated: $manifestPath ($(@($rows).Count) files)"
