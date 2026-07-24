[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RemovePath,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$CodexDir = Join-Path $HOME ".codex"
if (-not (Test-Path $CodexDir)) {
  throw "Codex state directory not found: $CodexDir"
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path (Split-Path $CodexDir -Parent) ".codex-backup-$Stamp"
Copy-Item -Path $CodexDir -Destination $BackupDir -Recurse -Force
Write-Host "Backup created: $BackupDir"

if (-not $RemovePath) {
  Write-Host "Backup complete. No path removal requested."
  exit 0
}

function Remove-ExactPathValue {
  param([object]$Node, [string]$Target)

  if ($null -eq $Node) { return $Node }
  if ($Node -is [System.Collections.IList]) {
    for ($i = $Node.Count - 1; $i -ge 0; $i--) {
      if ($Node[$i] -is [string] -and [string]::Equals($Node[$i], $Target, [System.StringComparison]::OrdinalIgnoreCase)) {
        $Node.RemoveAt($i)
      } else {
        $Node[$i] = Remove-ExactPathValue -Node $Node[$i] -Target $Target
      }
    }
    return $Node
  }
  if ($Node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($Property in @($Node.PSObject.Properties)) {
      if ($Property.Value -is [string] -and [string]::Equals($Property.Value, $Target, [System.StringComparison]::OrdinalIgnoreCase)) {
        $Node.PSObject.Properties.Remove($Property.Name)
      } else {
        $Property.Value = Remove-ExactPathValue -Node $Property.Value -Target $Target
      }
    }
  }
  return $Node
}

$Files = @(
  (Join-Path $CodexDir ".codex-global-state.json"),
  (Join-Path $CodexDir ".codex-global-state.json.bak")
) | Where-Object { Test-Path $_ }

foreach ($File in $Files) {
  $Json = Get-Content -Raw -Path $File | ConvertFrom-Json
  $Updated = Remove-ExactPathValue -Node $Json -Target $RemovePath
  $Rendered = $Updated | ConvertTo-Json -Depth 100
  if ($Apply) {
    if ($PSCmdlet.ShouldProcess($File, "remove exact path '$RemovePath'")) {
      Set-Content -Path $File -Value $Rendered -Encoding UTF8
      Write-Host "Patched: $File"
    }
  } else {
    Write-Host "Dry run: would patch $File to remove exact path '$RemovePath'. Use -Apply to write."
  }
}

Write-Host "Do not delete state_5.sqlite. Restart Codex after reviewing the backup and JSON changes."
