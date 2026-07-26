[CmdletBinding()]
param(
  [string]$Distribution,
  [string[]]$CodexArgs = @(),
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
$quotaSafeModel = if ($env:OPERATOR_CODEX_QUOTA_SAFE_MODEL) { $env:OPERATOR_CODEX_QUOTA_SAFE_MODEL } else { "gpt-5.5" }

if (-not $IsWindows) {
  Write-Error "Direct WSL continuity is available only from Windows hosts."
  exit 64
}

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
  Write-Error "wsl.exe was not found. Use the approved native Codex CLI or local route instead."
  exit 69
}

$joinedArgs = $CodexArgs -join " "
foreach ($feature in @("remote_plugin", "code_mode", "code_mode_only", "multi_agent_v2")) {
  if (
    $joinedArgs -match "--enable(?:=|\s+)$feature(?:\s|$)" -or
    $joinedArgs -match "(?:-c|--config)(?:=|\s+)features\.$feature\s*=\s*true"
  ) {
    Write-Error "Refusing to enable $feature while the Codex continuity guards are active."
    exit 64
  }
}

for ($index = 0; $index -lt $CodexArgs.Count; $index++) {
  $value = $CodexArgs[$index]
  $requestedModel = $null
  if (($value -eq "-m" -or $value -eq "--model") -and $index + 1 -lt $CodexArgs.Count) {
    $requestedModel = $CodexArgs[$index + 1]
  } elseif ($value -match "^--model=(.+)$") {
    $requestedModel = $Matches[1]
  } elseif ($value -match "^-m=(.+)$") {
    $requestedModel = $Matches[1]
  } elseif (($value -eq "-c" -or $value -eq "--config") -and $index + 1 -lt $CodexArgs.Count) {
    if ($CodexArgs[$index + 1] -match '^model\s*=\s*["'']?([^"'']+)["'']?$') { $requestedModel = $Matches[1] }
  }
  if ($requestedModel -and $requestedModel -ne $quotaSafeModel) {
    Write-Error "Refusing Codex model '$requestedModel' while recursive-subagent quota containment is active. Approved model: $quotaSafeModel."
    exit 64
  }
}
if ($joinedArgs -match 'model_reasoning_effort\s*=\s*["'']?ultra') {
  Write-Error "Refusing Ultra reasoning while it can activate automatic task delegation."
  exit 64
}

$base = @()
if ($Distribution) {
  $installed = @(& $wsl.Source -l -q 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($installed -notcontains $Distribution) {
    Write-Error "WSL distribution '$Distribution' is not installed."
    exit 69
  }
  $base += @("-d", $Distribution)
}

$probeScript = @'
set -eu
command -v codex >/dev/null 2>&1 || {
  echo "Codex CLI is not installed inside the selected WSL distribution." >&2
  exit 127
}
printf 'codex=%s\n' "$(command -v codex)"
printf 'codex_home=%s\n' "$HOME/.codex-direct"
printf 'model=%s\n' "$OPERATOR_CODEX_QUOTA_SAFE_MODEL"
printf 'remote_plugin=disabled\n'
printf 'code_mode=disabled\n'
printf 'code_mode_only=disabled\n'
printf 'multi_agent_v2=disabled\n'
printf 'agents_enabled=false\n'
'@

$previousSafeModel = $env:OPERATOR_CODEX_QUOTA_SAFE_MODEL
$env:OPERATOR_CODEX_QUOTA_SAFE_MODEL = $quotaSafeModel
try {
  & $wsl.Source @base -- sh -lc $probeScript
} finally {
  if ($null -eq $previousSafeModel) { Remove-Item Env:OPERATOR_CODEX_QUOTA_SAFE_MODEL -ErrorAction SilentlyContinue }
  else { $env:OPERATOR_CODEX_QUOTA_SAFE_MODEL = $previousSafeModel }
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($PreflightOnly) { exit 0 }

$modelSupplied = $joinedArgs -match '(?:^|\s)(?:-m|--model)(?:=|\s)'
$launchScript = @'
set -eu
export CODEX_HOME="$HOME/.codex-direct"
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME"
command -v codex >/dev/null 2>&1 || {
  echo "Codex CLI is not installed inside the selected WSL distribution." >&2
  exit 127
}
if [ "$1" = "--inject-model" ]; then
  shift
  exec codex --disable remote_plugin --disable code_mode --disable code_mode_only --disable multi_agent_v2 -c agents.enabled=false -c agents.max_concurrent_threads_per_session=1 -m "$OPERATOR_CODEX_QUOTA_SAFE_MODEL" "$@"
fi
shift
exec codex --disable remote_plugin --disable code_mode --disable code_mode_only --disable multi_agent_v2 -c agents.enabled=false -c agents.max_concurrent_threads_per_session=1 "$@"
'@

$mode = if ($modelSupplied) { "--model-supplied" } else { "--inject-model" }
$previousSafeModel = $env:OPERATOR_CODEX_QUOTA_SAFE_MODEL
$env:OPERATOR_CODEX_QUOTA_SAFE_MODEL = $quotaSafeModel
try {
  # The script body is fixed and user arguments are passed positionally after $0.
  # This avoids shell interpolation and keeps Windows and WSL state isolated.
  & $wsl.Source @base -- sh -lc $launchScript codex-direct $mode @CodexArgs
  $exitCode = $LASTEXITCODE
} finally {
  if ($null -eq $previousSafeModel) { Remove-Item Env:OPERATOR_CODEX_QUOTA_SAFE_MODEL -ErrorAction SilentlyContinue }
  else { $env:OPERATOR_CODEX_QUOTA_SAFE_MODEL = $previousSafeModel }
}
exit $exitCode
