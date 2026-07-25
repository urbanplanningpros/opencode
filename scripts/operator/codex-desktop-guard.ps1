[CmdletBinding()]
param(
  [string]$CodexHome = (Join-Path $HOME ".codex"),
  [long]$WarnSessionBytes = 209715200,
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Get-CodexDesktopVersion {
  if (-not $IsWindows) { return $null }

  $packages = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match "OpenAI\.(Codex|ChatGPT)" -or $_.PackageFullName -match "OpenAI\.(Codex|ChatGPT)"
  }
  if (-not $packages) { return $null }

  return ($packages | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()
}

$version = Get-CodexDesktopVersion
$affectedBuild = $false
if ($version) {
  $affectedBuild = $version -like "26.721.*"
}

$largeSessions = @()
if (Test-Path $CodexHome) {
  $largeSessions = @(
    Get-ChildItem -Path $CodexHome -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -ge $WarnSessionBytes } |
      Sort-Object Length -Descending |
      ForEach-Object {
        [pscustomobject]@{
          path = $_.FullName
          bytes = $_.Length
          megabytes = [math]::Round($_.Length / 1MB, 1)
          modified_at = $_.LastWriteTimeUtc.ToString("o")
        }
      }
  )
}

$browserBlocked = $IsWindows -and $affectedBuild
$largeThreadRisk = $largeSessions.Count -gt 0
$desktopRestricted = $browserBlocked -or $largeThreadRisk

$result = [ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("o")
  platform = if ($IsWindows) { "windows" } elseif ($IsMacOS) { "macos" } else { "other" }
  codex_desktop_version = $version
  affected_26_721_build = $affectedBuild
  browser_use_blocked = $browserBlocked
  large_thread_risk = $largeThreadRisk
  large_sessions = $largeSessions
  desktop_restricted = $desktopRestricted
  approved_route = if ($desktopRestricted) { "codex-cli-or-approved-local" } else { "desktop-with-normal-controls" }
  required_actions = @()
}

if ($browserBlocked) {
  $result.required_actions += "Do not use the Codex in-app browser on Windows build 26.721.x. Route browser work to an approved external browser workflow, Codex CLI, or the approved local route."
  $result.required_actions += "Do not rename or hide .git in an active repository as an operating workaround. Preserve Git state and change the execution surface instead."
}
if ($largeThreadRisk) {
  $result.required_actions += "Checkpoint the objective, acceptance criteria, changed files, and continuation prompt outside the desktop thread. Start a new thread before continuing."
  $result.required_actions += "Use Codex CLI or the approved local route for the current task until the oversized desktop session is archived and verified recoverable."
}
if ($desktopRestricted) {
  $result.required_actions += "Back up the complete .codex directory before repair, reset, reinstall, or state-file edits."
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
} else {
  Write-Host "Codex Desktop preflight"
  Write-Host "  Platform: $($result.platform)"
  Write-Host "  Version:  $($result.codex_desktop_version ?? 'not detected')"
  Write-Host "  Route:    $($result.approved_route)"
  if ($largeSessions.Count -gt 0) {
    Write-Host "  Large sessions: $($largeSessions.Count)"
    $largeSessions | ForEach-Object { Write-Host "    $($_.megabytes) MB  $($_.path)" }
  }
  foreach ($action in $result.required_actions) { Write-Host "  ACTION: $action" }
}

if ($desktopRestricted) { exit 2 }
exit 0
