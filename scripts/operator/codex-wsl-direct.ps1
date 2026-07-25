[CmdletBinding()]
param(
  [string]$Distribution,
  [string[]]$CodexArgs = @(),
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  Write-Error "Direct WSL continuity is available only from Windows hosts."
  exit 64
}

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
  Write-Error "wsl.exe was not found. Use the approved native Codex CLI or local route instead."
  exit 69
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
printf 'remote_plugin=disabled\n'
'@

& $wsl.Source @base -- sh -lc $probeScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($PreflightOnly) { exit 0 }

$launchScript = @'
set -eu
export CODEX_HOME="$HOME/.codex-direct"
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME"
command -v codex >/dev/null 2>&1 || {
  echo "Codex CLI is not installed inside the selected WSL distribution." >&2
  exit 127
}
exec codex --disable remote_plugin "$@"
'@

# The script body is fixed and user arguments are passed positionally after $0.
# This avoids shell interpolation, isolates Windows and WSL state, and disables
# the remote plugin catalog while the upstream cache write-amplification issue is unresolved.
& $wsl.Source @base -- sh -lc $launchScript codex-direct @CodexArgs
exit $LASTEXITCODE
