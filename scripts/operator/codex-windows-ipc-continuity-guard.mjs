import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      i += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJson(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function text(value, name, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return ""
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function finiteNumber(value, name, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative finite number`)
  return parsed
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJson(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
if (prohibited.test(JSON.stringify({ evidence, provider: args.provider, route: args.route, env: process.env.OPERATOR_ROUTE }))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let taskId
let operationId
let platform
let desktopBuild
let canonicalTaskState
let rerouteTarget
let wmiSnapshotRatePerSecond
let sandboxCommandDispatchState
let dpapiErrorCode
try {
  taskId = text(evidence.task_id, "task_id")
  operationId = text(evidence.operation_id, "operation_id")
  platform = text(evidence.platform, "platform").toLowerCase()
  desktopBuild = text(evidence.desktop_build, "desktop_build", true)
  canonicalTaskState = text(evidence.canonical_task_state, "canonical_task_state", true).toLowerCase()
  rerouteTarget = text(evidence.reroute_target, "reroute_target", true).toLowerCase()
  wmiSnapshotRatePerSecond = finiteNumber(evidence.wmi_snapshot_rate_per_second, "wmi_snapshot_rate_per_second")
  sandboxCommandDispatchState = text(
    evidence.sandbox_command_dispatch_state,
    "sandbox_command_dispatch_state",
    true,
  ).toLowerCase()
  dpapiErrorCode = text(evidence.dpapi_error_code, "dpapi_error_code", true).toLowerCase()
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const windows = platform.includes("windows")
const affectedIpcBuild = desktopBuild === "26.721.4979.0"
const affectedWmiBuild = desktopBuild === "26.721.11231.0"
const knownDpapiBuild = new Set(["26.721.41059", "26.721.4979.0"]).has(desktopBuild)
const browserIntegrationEnabled = bool(evidence.browser_integration_enabled, "browser_integration_enabled")
const longRunningOrConcurrent =
  bool(evidence.long_running_task, "long_running_task") || Number(evidence.concurrent_task_count || 0) > 1
const browserClientClosed = bool(evidence.browser_sidebar_client_closed, "browser_sidebar_client_closed")
const epipeObserved = bool(evidence.epipe_observed, "epipe_observed")
const writeEofUncaught = bool(evidence.write_eof_uncaught, "write_eof_uncaught")
const appServerDisconnected = bool(evidence.app_server_disconnected, "app_server_disconnected")
const uncertainWritesReconciled = bool(evidence.uncertain_writes_reconciled, "uncertain_writes_reconciled")
const interruptedTurnReconciled = bool(evidence.interrupted_turn_reconciled, "interrupted_turn_reconciled")
const childProcessesInventoried = bool(evidence.child_processes_inventoried, "child_processes_inventoried")
const automaticReplayAttempted = bool(evidence.automatic_replay_attempted, "automatic_replay_attempted")
const browserRouteDisabled = bool(evidence.browser_route_disabled, "browser_route_disabled")
const systemWideInputLagObserved = bool(evidence.system_wide_input_lag_observed, "system_wide_input_lag_observed")
const powershellWmiSnapshotChildrenObserved = bool(
  evidence.powershell_wmi_snapshot_children_observed,
  "powershell_wmi_snapshot_children_observed",
)
const wmiActivityErrorObserved = bool(evidence.wmi_activity_error_observed, "wmi_activity_error_observed")
const desktopExecutionIsolated = bool(evidence.desktop_execution_isolated, "desktop_execution_isolated")
const unsafeWmiSuppressionApplied = bool(evidence.unsafe_wmi_suppression_applied, "unsafe_wmi_suppression_applied")
const cryptUnprotectDataFailureObserved = bool(
  evidence.crypt_unprotect_data_failure_observed,
  "crypt_unprotect_data_failure_observed",
)
const nativeWindowsSandboxIsolated = bool(
  evidence.native_windows_sandbox_isolated,
  "native_windows_sandbox_isolated",
)
const unsafeDpapiRepairAttempted = bool(evidence.unsafe_dpapi_repair_attempted, "unsafe_dpapi_repair_attempted")

const ipcFailure = windows && (epipeObserved || writeEofUncaught || appServerDisconnected)
const unsafeAffectedPreflight = windows && affectedIpcBuild && browserIntegrationEnabled && longRunningOrConcurrent
const wmiSnapshotPressure =
  windows &&
  affectedWmiBuild &&
  (systemWideInputLagObserved ||
    powershellWmiSnapshotChildrenObserved ||
    wmiActivityErrorObserved ||
    wmiSnapshotRatePerSecond >= 1)
const dpapiErrorMatches = new Set(["2148073483", "0x8009000b", "nte_bad_key_state"]).has(dpapiErrorCode)
const dpapiSandboxFailure = windows && (cryptUnprotectDataFailureObserved || dpapiErrorMatches)
const canonicalStateValid = new Set(["active", "completed", "failed", "unknown"]).has(canonicalTaskState)
const sandboxDispatchStateValid = new Set(["none", "not_dispatched", "completed", "unknown"]).has(
  sandboxCommandDispatchState || "none",
)
const approvedReroute = new Set(["approved_linux_vps", "authorized_local_linux", "none"]).has(rerouteTarget || "none")

let admitted = true
let reason = "windows_ipc_continuity_verified"
let exitCode = 0

if (!approvedReroute) {
  admitted = false
  reason = "unapproved_reroute_target"
  exitCode = 64
} else if (!sandboxDispatchStateValid) {
  admitted = false
  reason = "invalid_sandbox_command_dispatch_state"
  exitCode = 2
} else if (unsafeDpapiRepairAttempted) {
  admitted = false
  reason = "unsafe_dpapi_repair_forbidden"
  exitCode = 64
} else if (unsafeWmiSuppressionApplied) {
  admitted = false
  reason = "unsafe_wmi_snapshot_suppression_forbidden"
  exitCode = 64
} else if (automaticReplayAttempted) {
  admitted = false
  reason = "automatic_replay_forbidden_after_ipc_failure"
  exitCode = 64
} else if (dpapiSandboxFailure && sandboxCommandDispatchState !== "not_dispatched") {
  admitted = false
  reason = "dpapi_failed_command_non_dispatch_not_proven"
  exitCode = 75
} else if (dpapiSandboxFailure && !nativeWindowsSandboxIsolated) {
  admitted = false
  reason = "windows_dpapi_sandbox_failure_not_isolated"
  exitCode = 75
} else if (ipcFailure && !uncertainWritesReconciled) {
  admitted = false
  reason = "uncertain_writes_not_reconciled"
  exitCode = 75
} else if (ipcFailure && (!canonicalStateValid || canonicalTaskState === "unknown")) {
  admitted = false
  reason = "canonical_task_state_unknown_after_ipc_failure"
  exitCode = 75
} else if (ipcFailure && !interruptedTurnReconciled) {
  admitted = false
  reason = "interrupted_turn_not_reconciled"
  exitCode = 75
} else if (ipcFailure && !childProcessesInventoried) {
  admitted = false
  reason = "orphan_child_process_inventory_required"
  exitCode = 75
} else if (unsafeAffectedPreflight && !browserRouteDisabled) {
  admitted = false
  reason = "affected_windows_browser_ipc_route_not_isolated"
  exitCode = 75
} else if (wmiSnapshotPressure && !desktopExecutionIsolated) {
  admitted = false
  reason = "windows_wmi_snapshot_pressure_not_isolated"
  exitCode = 75
} else if (dpapiSandboxFailure && nativeWindowsSandboxIsolated) {
  reason = "windows_dpapi_sandbox_failure_contained"
} else if (wmiSnapshotPressure && desktopExecutionIsolated) {
  reason = "windows_wmi_snapshot_pressure_contained"
} else if (browserClientClosed && !epipeObserved && !writeEofUncaught && !appServerDisconnected) {
  reason = "browser_client_closed_cleanly"
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  platform,
  desktop_build: desktopBuild || null,
  affected_ipc_build: affectedIpcBuild,
  affected_wmi_build: affectedWmiBuild,
  known_dpapi_build: knownDpapiBuild,
  ipc_failure: ipcFailure,
  browser_integration_enabled: browserIntegrationEnabled,
  browser_route_disabled: browserRouteDisabled,
  canonical_task_state: canonicalTaskState || null,
  uncertain_writes_reconciled: uncertainWritesReconciled,
  interrupted_turn_reconciled: interruptedTurnReconciled,
  child_processes_inventoried: childProcessesInventoried,
  wmi_snapshot_pressure: wmiSnapshotPressure,
  wmi_snapshot_rate_per_second: wmiSnapshotRatePerSecond,
  system_wide_input_lag_observed: systemWideInputLagObserved,
  powershell_wmi_snapshot_children_observed: powershellWmiSnapshotChildrenObserved,
  wmi_activity_error_observed: wmiActivityErrorObserved,
  desktop_execution_isolated: desktopExecutionIsolated,
  dpapi_sandbox_failure: dpapiSandboxFailure,
  dpapi_error_code: dpapiErrorCode || null,
  sandbox_command_dispatch_state: sandboxCommandDispatchState || "none",
  native_windows_sandbox_isolated: nativeWindowsSandboxIsolated,
  reroute_target: rerouteTarget || "none",
  protocol: admitted
    ? "Continue through guarded direct OpenAI and the approved execution route. Keep the task ID, operation ID, idempotency ledger, repository state, canonical task state, child-process inventory, Windows WMI pressure evidence, and Windows sandbox dispatch receipt authoritative."
    : "Stop only the affected Windows Desktop, browser-control, or native sandbox execution turn. Preserve task and repository state, prove whether the failed command was dispatched, reconcile uncertain writes, read canonical task state, inventory surviving child processes, avoid destructive DPAPI repair or fake WMI suppression, isolate Windows native sandbox execution, and continue through the approved Linux VPS or explicitly authorized local Linux route without replaying completed work.",
  resume_condition:
    "Restore affected Windows Desktop production authority only after a corrected stable build passes repeated IPC, DPAPI credential-regeneration, idle, and active-task canaries with no uncaught EPIPE/EOF, no app-server loss, no CryptUnprotectData 0x8009000B failure, no recurring PowerShell WMI full-process snapshots, no system-wide input lag, no retry amplification, correct same-task recovery, and no duplicate external writes.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
