import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular non-symlink file`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function integer(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer: ${value}`)
  return parsed
}

function inspectWindowsSessions() {
  const shell = process.env.PWSH_EXE || (process.platform === "win32" ? "powershell.exe" : "pwsh")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sessionIds = New-Object 'System.Collections.Generic.HashSet[string]'",
    "$links = Get-CimInstance -ClassName Win32_LoggedOnUser",
    "foreach ($link in $links) {",
    "  $accountRef = [string]$link.Antecedent",
    "  if ($accountRef -match 'Name=\"CodexSandboxOffline\"') {",
    "    $sessionRef = [string]$link.Dependent",
    "    if ($sessionRef -match 'LogonId=\"([^\"]+)\"') { [void]$sessionIds.Add($Matches[1]) }",
    "  }",
    "}",
    "$interactive = @(Get-CimInstance -ClassName Win32_LogonSession | Where-Object { [int]$_.LogonType -eq 2 }).Count",
    "$lsass = Get-Process -Name lsass -ErrorAction Stop",
    "[pscustomobject]@{",
    "  platform = 'win32'",
    "  observed_at = (Get-Date).ToUniversalTime().ToString('o')",
    "  codex_sandbox_logon_sessions = [int]$sessionIds.Count",
    "  interactive_logon_sessions = [int]$interactive",
    "  lsass_handles = [int64]$lsass.HandleCount",
    "  session_probe_complete = $true",
    "} | ConvertTo-Json -Compress",
  ].join("; ")

  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    shell: false,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "Windows logon-session inspection failed").trim()
    throw new Error(detail)
  }
  return JSON.parse(String(result.stdout).trim())
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const routingMetadata = JSON.stringify({
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
})

if (prohibited.test(routingMetadata)) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let evidence
try {
  evidence = args.evidence ? readJsonFile(path.resolve(String(args.evidence))) : null
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const platform = String(evidence?.platform || process.platform).toLowerCase()
if (!evidence && platform !== "win32") {
  console.log(
    JSON.stringify(
      {
        admitted: true,
        reason: "non_windows_route",
        protocol: "Continue through the guarded direct OpenAI or explicitly authorized local route.",
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

try {
  evidence = evidence || inspectWindowsSessions()
} catch (error) {
  console.error(
    JSON.stringify(
      {
        admitted: false,
        reason: "windows_session_state_unverified",
        detail: error.message,
        protocol:
          "Withhold only Windows sandbox command authority. Preserve task state and continue through the approved Linux VPS or explicitly authorized local Linux route until the session probe succeeds.",
      },
      null,
      2,
    ),
  )
  process.exit(75)
}

let warningSessions
let criticalSessions
let warningHandles
let criticalHandles
let minimumCanaryInvocations
try {
  warningSessions = integer(args["warning-sessions"], 250)
  criticalSessions = integer(args["critical-sessions"], 1000)
  warningHandles = integer(args["warning-handles"], 10000)
  criticalHandles = integer(args["critical-handles"], 25000)
  minimumCanaryInvocations = integer(args["minimum-canary-invocations"], 500)
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_threshold", detail: error.message }, null, 2))
  process.exit(2)
}

if (criticalSessions < warningSessions || criticalHandles < warningHandles) {
  console.error(
    JSON.stringify(
      {
        admitted: false,
        reason: "invalid_threshold_order",
        detail: "critical thresholds must be greater than or equal to warning thresholds",
      },
      null,
      2,
    ),
  )
  process.exit(2)
}

const operation = String(args.operation || evidence.operation || "unknown").toLowerCase()
const currentSessions = integer(evidence.codex_sandbox_logon_sessions, 0)
const baselineSessions = integer(evidence.baseline_codex_sandbox_logon_sessions, currentSessions)
const sessionDelta = currentSessions - baselineSessions
const lsassHandles = integer(evidence.lsass_handles, 0)
const sessionProbeComplete = evidence.session_probe_complete !== false
const fixedBuildAttested = evidence.release_fix_attested === true
const canaryInvocations = integer(evidence.canary_invocations, 0)
const canarySessionDelta = Number(evidence.canary_session_delta ?? Number.NaN)
const networkDenialPassed = evidence.network_denial_passed === true
const pipedSpawnPassed = evidence.piped_spawn_passed === true
const fixedBuildCanaryPassed =
  fixedBuildAttested &&
  canaryInvocations >= minimumCanaryInvocations &&
  Number.isFinite(canarySessionDelta) &&
  canarySessionDelta === 0 &&
  networkDenialPassed &&
  pipedSpawnPassed

const directSandboxInvocation = ["codex_sandbox", "sandbox", "codex sandbox"].includes(operation)
const criticalPressure = currentSessions >= criticalSessions || lsassHandles >= criticalHandles
const warningPressure = currentSessions >= warningSessions || lsassHandles >= warningHandles || sessionDelta >= 5
const leakObserved = sessionDelta > 0

let admitted = true
let reason = "windows_session_state_bounded"

if (!sessionProbeComplete) {
  admitted = false
  reason = "windows_session_probe_incomplete"
} else if (directSandboxInvocation && !fixedBuildCanaryPassed) {
  admitted = false
  reason = "codex_sandbox_session_leak_unfixed"
} else if (criticalPressure) {
  admitted = false
  reason = "windows_lsass_or_logon_session_pressure_critical"
} else if (leakObserved || warningPressure) {
  admitted = false
  reason = leakObserved ? "windows_sandbox_session_growth_detected" : "windows_lsass_or_logon_session_pressure_warning"
}

const recovery =
  "Checkpoint task state and reconcile uncertain writes. Stop scheduling new Windows sandbox commands, keep Windows as a control surface only, and continue command execution through the approved Linux VPS or an explicitly authorized local Linux runner. Do not switch to unelevated sandbox as a workaround because network denial and piped child-process behavior are not verified. A reboot is the only currently reported way to reclaim orphaned LSASS logon sessions after state is safely persisted."

const report = {
  admitted,
  reason,
  platform,
  operation,
  observed_at: evidence.observed_at ?? new Date().toISOString(),
  codex_version: evidence.codex_version ?? null,
  codex_sandbox_logon_sessions: currentSessions,
  baseline_codex_sandbox_logon_sessions: baselineSessions,
  session_delta: sessionDelta,
  interactive_logon_sessions: evidence.interactive_logon_sessions ?? null,
  lsass_handles: lsassHandles,
  pressure: criticalPressure ? "critical" : warningPressure || leakObserved ? "warning" : "bounded",
  fixed_build_canary_passed: fixedBuildCanaryPassed,
  protocol: admitted
    ? "Permit the bounded Windows route while continuing periodic logon-session and LSASS-handle sampling."
    : recovery,
  resume_condition:
    "Resume Windows codex sandbox authority only after a stable build completes at least 500 sandbox invocations with zero net CodexSandboxOffline session growth, verified network denial, successful piped child-process execution, and no persistent LSASS-handle growth.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(admitted ? 0 : 75)
