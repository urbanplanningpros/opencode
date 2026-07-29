import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      index += 1
    } else out[key] = true
  }
  return out
}

function text(value, name, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return ""
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function number(value, name, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`)
  return parsed
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }))
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }))
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const routing = evidence.routing || {}
if (prohibited.test(`${routing.provider || ""} ${routing.route || ""}`)) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }))
  process.exit(64)
}

let taskId
let operationId
let platform
let desktopBuild
let committedMemoryPercent
let stdioMcpProcessCount
let configuredStdioMcpServerCount
let activeTaskCount
let residualStdioAppServers
try {
  taskId = text(evidence.task_id, "task_id")
  operationId = text(evidence.operation_id, "operation_id")
  platform = text(evidence.platform, "platform").toLowerCase()
  desktopBuild = text(evidence.desktop_build, "desktop_build", true)
  committedMemoryPercent = number(evidence.committed_memory_percent, "committed_memory_percent")
  stdioMcpProcessCount = number(evidence.stdio_mcp_process_count, "stdio_mcp_process_count")
  configuredStdioMcpServerCount = number(evidence.configured_stdio_mcp_server_count, "configured_stdio_mcp_server_count")
  activeTaskCount = number(evidence.active_task_count, "active_task_count", 1)
  residualStdioAppServers = number(evidence.residual_stdio_app_server_processes, "residual_stdio_app_server_processes")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }))
  process.exit(2)
}

const windows = platform.includes("windows")
const affectedBuild = desktopBuild === "26.721.4979.0"
const duplicateChains = bool(evidence.duplicate_stdio_mcp_chains_observed, "duplicate_stdio_mcp_chains_observed")
const liveKernelEvent = bool(evidence.live_kernel_event_0x1cc_observed, "live_kernel_event_0x1cc_observed")
const systemHang = bool(evidence.system_hang_observed, "system_hang_observed")
const unexpectedReboot = bool(evidence.unexpected_reboot_observed, "unexpected_reboot_observed")
const startupDisabled = bool(evidence.automatic_stdio_mcp_startup_disabled, "automatic_stdio_mcp_startup_disabled")
const desktopIsolated = bool(evidence.desktop_execution_isolated, "desktop_execution_isolated")
const processInventoryComplete = bool(evidence.mcp_process_inventory_complete, "mcp_process_inventory_complete")
const uncertainWritesReconciled = bool(evidence.uncertain_writes_reconciled, "uncertain_writes_reconciled")
const bulkKillAttempted = bool(evidence.bulk_process_kill_attempted, "bulk_process_kill_attempted")
const stdioConnectionClosed = bool(evidence.stdio_connection_closed, "stdio_connection_closed")
const residualBoundToOperation = bool(evidence.residual_processes_bound_to_operation, "residual_processes_bound_to_operation")
const wrapperTerminatedResidual = bool(evidence.wrapper_terminated_residual_app_server, "wrapper_terminated_residual_app_server")
const appServerExitReason = text(evidence.app_server_exit_reason, "app_server_exit_reason", true)
const pinnedStableContainsStdioFix = bool(evidence.pinned_stable_contains_stdio_close_fix, "pinned_stable_contains_stdio_close_fix")

const expectedProcessCeiling = Math.max(1, configuredStdioMcpServerCount) * Math.max(1, activeTaskCount)
const processFanoutExceeded = stdioMcpProcessCount > expectedProcessCeiling
const criticalPressure =
  windows &&
  affectedBuild &&
  (duplicateChains || processFanoutExceeded || committedMemoryPercent >= 90 || liveKernelEvent || systemHang || unexpectedReboot)
const residualAfterClose = windows && stdioConnectionClosed && residualStdioAppServers > 0

let admitted = true
let reason = "windows_mcp_resource_continuity_verified"
let exitCode = 0

if (bulkKillAttempted) {
  admitted = false
  reason = "bulk_process_kill_forbidden"
  exitCode = 64
} else if (criticalPressure && !uncertainWritesReconciled) {
  admitted = false
  reason = "uncertain_writes_not_reconciled_after_resource_failure"
  exitCode = 75
} else if (criticalPressure && !processInventoryComplete) {
  admitted = false
  reason = "mcp_process_inventory_required"
  exitCode = 75
} else if (criticalPressure && !startupDisabled) {
  admitted = false
  reason = "automatic_stdio_mcp_startup_must_be_disabled"
  exitCode = 75
} else if (criticalPressure && !desktopIsolated) {
  admitted = false
  reason = "windows_desktop_execution_must_be_isolated"
  exitCode = 75
} else if (residualAfterClose && !residualBoundToOperation) {
  admitted = false
  reason = "residual_stdio_app_server_not_bound_to_operation"
  exitCode = 75
} else if (residualAfterClose && !wrapperTerminatedResidual) {
  admitted = false
  reason = "terminate_bound_residual_stdio_app_server"
  exitCode = 75
} else if (criticalPressure) {
  reason = "windows_mcp_resource_pressure_contained"
} else if (stdioConnectionClosed && !pinnedStableContainsStdioFix && appServerExitReason !== "stdio_connection_closed") {
  reason = "stdio_close_fix_not_in_pinned_stable_wrapper_watch_required"
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  platform,
  desktop_build: desktopBuild || null,
  affected_build: affectedBuild,
  critical_resource_pressure: criticalPressure,
  duplicate_stdio_mcp_chains_observed: duplicateChains,
  process_fanout_exceeded: processFanoutExceeded,
  expected_stdio_mcp_process_ceiling: expectedProcessCeiling,
  stdio_mcp_process_count: stdioMcpProcessCount,
  committed_memory_percent: committedMemoryPercent,
  live_kernel_event_0x1cc_observed: liveKernelEvent,
  system_hang_observed: systemHang,
  unexpected_reboot_observed: unexpectedReboot,
  automatic_stdio_mcp_startup_disabled: startupDisabled,
  desktop_execution_isolated: desktopIsolated,
  mcp_process_inventory_complete: processInventoryComplete,
  residual_stdio_app_server_processes: residualStdioAppServers,
  residual_processes_bound_to_operation: residualBoundToOperation,
  pinned_stable_contains_stdio_close_fix: pinnedStableContainsStdioFix,
  evidence_sha256: crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  continuity_route: "Windows Desktop control surface to pinned direct OpenAI plus approved Linux or authorized local execution",
  protocol: admitted
    ? "Continue business-critical work through the approved route. Keep automatic STDIO MCP startup disabled when pressure is present, cap one reviewed MCP process chain per task/server pair, and verify stdio app-server exit after controller closure."
    : "Stop only the affected Windows Desktop execution path. Preserve task and operation IDs, reconcile writes, inventory and bind processes, disable automatic STDIO MCP startup, isolate Desktop execution, and continue the exact unfinished action through the approved route without replay.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
