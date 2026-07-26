[CmdletBinding()]
param(
  [string]$CodexHome = (Join-Path $HOME ".codex"),
  [long]$WarnSessionBytes = 209715200,
  [int]$CodeIntegrityLookbackMinutes = 240,
  [string]$DesktopVersionOverride,
  [string]$PackageStatusOverride,
  [switch]$SimulateWindows,
  [switch]$SimulateWslAvailable,
  [switch]$SimulateCodeIntegrityEvent,
  [switch]$ReportOnly,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$platformWindows = $IsWindows -or $SimulateWindows

function Get-CodexDesktopPackage {
  if ($DesktopVersionOverride -or $PackageStatusOverride) {
    return [pscustomobject]@{
      version = $DesktopVersionOverride
      status = $PackageStatusOverride
      package_full_name = "simulated"
    }
  }
  if (-not $platformWindows) { return $null }

  $packages = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match "OpenAI\.(Codex|ChatGPT)" -or $_.PackageFullName -match "OpenAI\.(Codex|ChatGPT)"
  }
  if (-not $packages) { return $null }

  $selected = $packages | Sort-Object Version -Descending | Select-Object -First 1
  return [pscustomobject]@{
    version = $selected.Version.ToString()
    status = if ($null -ne $selected.Status) { $selected.Status.ToString() } else { $null }
    package_full_name = $selected.PackageFullName
  }
}

function Get-CodeIntegritySwiftShaderEvents {
  if ($SimulateCodeIntegrityEvent) {
    return @([pscustomobject]@{
      id = 3033
      created_at = (Get-Date).ToUniversalTime().ToString("o")
      source = "simulated"
    })
  }
  if (-not $IsWindows) { return @() }

  try {
    return @(
      Get-WinEvent -FilterHashtable @{
        LogName = "Microsoft-Windows-CodeIntegrity/Operational"
        Id = 3033
        StartTime = (Get-Date).AddMinutes(-1 * $CodeIntegrityLookbackMinutes)
      } -ErrorAction Stop |
        Where-Object {
          $_.Message -match "(OpenAI\.Codex|ChatGPT\.exe)" -and
          $_.Message -match "vk_swiftshader\.dll"
        } |
        Select-Object -First 20 |
        ForEach-Object {
          [pscustomobject]@{
            id = $_.Id
            created_at = $_.TimeCreated.ToUniversalTime().ToString("o")
            source = $_.ProviderName
          }
        }
    )
  } catch {
    return @()
  }
}

$desktopPackage = Get-CodexDesktopPackage
$version = if ($desktopPackage) { $desktopPackage.version } else { $null }
$packageStatus = if ($desktopPackage) { $desktopPackage.status } else { $null }
$affectedBuild = $false
$affectedCodeIntegrityBuild = $false
if ($version) {
  $affectedBuild = $version -like "26.721.*"
  $affectedCodeIntegrityBuild = $version -like "26.721.4979.*"
}

$codeIntegrityEvents = @(Get-CodeIntegritySwiftShaderEvents)
$codeIntegrityEventDetected = $codeIntegrityEvents.Count -gt 0
$packageNeedsRemediation = [bool]($packageStatus -match "Modified|NeedsRemediation")
$desktopPackageLaunchBlocked = $affectedCodeIntegrityBuild -and ($codeIntegrityEventDetected -or $packageNeedsRemediation)

$wslAvailable = $false
if ($platformWindows) {
  $wslAvailable = $SimulateWslAvailable -or [bool](Get-Command wsl.exe -ErrorAction SilentlyContinue)
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

$browserBlocked = $platformWindows -and $affectedBuild
$remoteControlBlocked = $platformWindows -and $affectedBuild
$wslDesktopIntegrationBlocked = $platformWindows -and $affectedBuild -and $wslAvailable
$largeThreadRisk = $largeSessions.Count -gt 0
$desktopRestricted = $browserBlocked -or $remoteControlBlocked -or $wslDesktopIntegrationBlocked -or $largeThreadRisk -or $desktopPackageLaunchBlocked

$result = [ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("o")
  platform = if ($platformWindows) { "windows" } elseif ($IsMacOS) { "macos" } else { "other" }
  codex_desktop_version = $version
  package_status = $packageStatus
  package_needs_remediation = $packageNeedsRemediation
  affected_26_721_build = $affectedBuild
  affected_code_integrity_build = $affectedCodeIntegrityBuild
  code_integrity_event_3033_detected = $codeIntegrityEventDetected
  code_integrity_event_count = $codeIntegrityEvents.Count
  code_integrity_events = $codeIntegrityEvents
  desktop_package_launch_blocked = $desktopPackageLaunchBlocked
  browser_use_blocked = $browserBlocked
  mobile_remote_control_blocked = $remoteControlBlocked
  wsl_available = $wslAvailable
  desktop_wsl_integration_blocked = $wslDesktopIntegrationBlocked
  large_thread_risk = $largeThreadRisk
  large_sessions = $largeSessions
  desktop_restricted = $desktopRestricted
  report_only = [bool]$ReportOnly
  approved_route = if ($desktopRestricted) { "codex-cli-direct-wsl-or-approved-local" } else { "desktop-with-normal-controls" }
  required_actions = @()
}

if ($affectedCodeIntegrityBuild) {
  $result.required_actions += "Treat Windows Codex Desktop 26.721.4979.x as unavailable when it closes shortly after launch, Code Integrity event 3033 names vk_swiftshader.dll, or the AppX package reports Modified/NeedsRemediation."
  $result.required_actions += "Do not repeatedly relaunch the package or loop winget repair/Add-AppxPackage registration. Reported repairs clear the package flag only until the next blocked launch."
  $result.required_actions += "Do not copy and execute the WindowsApps payload outside the MSIX container as an operating workaround. Preserve the signed-package boundary and route work through guarded Codex CLI, direct WSL CLI, or the approved local route."
  $result.required_actions += "Preserve evidence using the Code Integrity Operational log event 3033 timestamp and Get-AppxPackage status; do not weaken HVCI, WDAC, Smart App Control, or enterprise signing policy."
}
if ($browserBlocked) {
  $result.required_actions += "Do not use the Codex in-app browser on Windows build 26.721.x. Route browser work to an approved external browser workflow, guarded Codex CLI, or the approved local route."
  $result.required_actions += "Treat an 'enterprise network policy blocked' result on a normal public site as a Desktop compatibility failure after host firewall, VPN, and proxy checks pass; do not weaken enterprise policy to make Desktop navigation succeed."
  $result.required_actions += "Do not rename or hide .git in an active repository as an operating workaround. Preserve Git state and change the execution surface instead."
}
if ($remoteControlBlocked) {
  $result.required_actions += "Do not rely on mobile wake, remote control, or remote approval as the only control path for Windows Codex Desktop 26.721.x. Keep a direct CLI, local console, or approved local operator route available."
  $result.required_actions += "Before leaving a host unattended, checkpoint the task manifest and ensure connector writes remain in the durable idempotent queue. A failed mobile connection is not evidence that an external write did not execute."
}
if ($wslDesktopIntegrationBlocked) {
  $result.required_actions += "Do not use the Codex Desktop WSL agent environment on build 26.721.x. Its runtime installer can pass Windows paths to Linux tar and plugin RPCs can remain blocked until timeout."
  $result.required_actions += "Run scripts/operator/codex-wsl-direct.ps1 to invoke Codex directly inside WSL with an isolated Linux-native CODEX_HOME at `$HOME/.codex-direct."
  $result.required_actions += "Do not share the Windows %USERPROFILE%\.codex databases with the direct WSL route; mixed runtime versions can create incompatible SQLite migration state."
}
if ($largeThreadRisk) {
  $result.required_actions += "Checkpoint the objective, acceptance criteria, changed files, and continuation prompt outside the desktop thread. Start a new thread before continuing."
  $result.required_actions += "Use guarded Codex CLI, direct WSL CLI, or the approved local route for the current task until the oversized desktop session is archived and verified recoverable."
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
  Write-Host "  Package:  $($result.package_status ?? 'not detected')"
  Write-Host "  Route:    $($result.approved_route)"
  Write-Host "  CI 3033:  $(if ($result.code_integrity_event_3033_detected) { 'detected' } else { 'not detected' })"
  Write-Host "  Browser:  $(if ($result.browser_use_blocked) { 'blocked' } else { 'normal controls' })"
  Write-Host "  Remote:   $(if ($result.mobile_remote_control_blocked) { 'blocked' } else { 'normal controls' })"
  if ($largeSessions.Count -gt 0) {
    Write-Host "  Large sessions: $($largeSessions.Count)"
    $largeSessions | ForEach-Object { Write-Host "    $($_.megabytes) MB  $($_.path)" }
  }
  foreach ($action in $result.required_actions) { Write-Host "  ACTION: $action" }
}

if ($desktopRestricted -and -not $ReportOnly) { exit 2 }
exit 0
