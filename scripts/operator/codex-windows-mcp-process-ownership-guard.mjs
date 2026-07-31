import fs from "node:fs"
import path from "node:path"

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

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function object(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_api", "direct_openai_app_server", "approved_local_openai", "approved_local_windows", "approved_local_linux"])

if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (prohibited.test(JSON.stringify(evidence))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let host
let mcp
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  host = object(evidence.host, "host")
  mcp = object(evidence.mcp_process, "mcp_process")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const platform = nonEmptyString(host.platform, "host.platform").toLowerCase()
const hostPid = nonEmptyString(String(host.pid), "host.pid")
const hostCreationIdentity = optionalString(host.creation_identity, "host.creation_identity")
const hostAncestorsExcluded = boolean(host.ancestors_excluded_from_termination, "host.ancestors_excluded_from_termination")
const siblingProcessesExcluded = boolean(host.sibling_processes_excluded_from_termination, "host.sibling_processes_excluded_from_termination")

const mcpPid = nonEmptyString(String(mcp.pid), "mcp_process.pid")
const terminationMethod = nonEmptyString(mcp.termination_method, "mcp_process.termination_method").toLowerCase()
const jobObjectAssigned = boolean(mcp.job_object_assigned, "mcp_process.job_object_assigned")
const jobKillOnClose = boolean(mcp.job_kill_on_close, "mcp_process.job_kill_on_close")
const directChildHandleOwned = boolean(mcp.direct_child_handle_owned, "mcp_process.direct_child_handle_owned")
const suspendedAssignmentUsed = boolean(mcp.suspended_assignment_used, "mcp_process.suspended_assignment_used")
const gracefulShutdownAttempted = boolean(mcp.graceful_shutdown_attempted, "mcp_process.graceful_shutdown_attempted")
const processCreationIdentityVerified = boolean(mcp.process_creation_identity_verified, "mcp_process.process_creation_identity_verified")
const staleParentEdgesRejected = boolean(mcp.stale_parent_edges_rejected, "mcp_process.stale_parent_edges_rejected")
const cycleDetectionPassed = boolean(mcp.cycle_detection_passed, "mcp_process.cycle_detection_passed")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const automaticRetryRequested = boolean(state.automatic_retry_requested, "state.automatic_retry_requested")
const broadHostRestartRequested = boolean(state.broad_host_restart_requested, "state.broad_host_restart_requested")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const canaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && canaryPassed && operationBindingMatches && taskStatePreserved && externalWritesReconciled

const pidTreeMethod = new Set(["taskkill_tree", "taskkill_/t", "pid_tree", "ppid_tree", "numeric_pid_tree"]).has(terminationMethod)
const ownedJobMethod = terminationMethod === "job_object" && jobObjectAssigned && jobKillOnClose && suspendedAssignmentUsed
const ownedDirectChildFallback = terminationMethod === "direct_child_handle" && directChildHandleOwned && processCreationIdentityVerified
const ownershipSafe = ownedJobMethod || ownedDirectChildFallback
const containmentVerified = hostAncestorsExcluded && siblingProcessesExcluded && staleParentEdgesRejected && cycleDetectionPassed

let admitted = true
let reason = "mcp_process_ownership_verified"
let action = "continue_windows_mcp_operation"
let exitCode = 0

if (platform !== "windows") {
  reason = "guard_not_applicable_to_non_windows_host"
  action = "continue_under_platform_specific_process_policy"
} else if (pidTreeMethod) {
  admitted = false
  reason = "numeric_pid_tree_termination_rejected"
  action = routeReady
    ? "isolate_windows_stdio_mcp_cleanup_and_continue_via_verified_route"
    : "preserve_state_reconcile_writes_and_establish_verified_route"
  exitCode = 75
} else if (!ownershipSafe) {
  admitted = false
  reason = "mcp_termination_lacks_durable_process_ownership"
  action = "assign_per_mcp_job_object_or_use_owned_direct_child_handle_only"
  exitCode = 75
} else if (!containmentVerified) {
  admitted = false
  reason = "host_or_sibling_process_exclusion_not_proven"
  action = "verify_creation_identity_reject_stale_edges_and_pass_cycle_canary"
  exitCode = 75
} else if (!gracefulShutdownAttempted) {
  admitted = false
  reason = "bounded_graceful_shutdown_required_before_forced_termination"
  action = "close_mcp_stdin_wait_bounded_grace_period_then_terminate_owned_job"
  exitCode = 75
} else if ((automaticRetryRequested || broadHostRestartRequested) && (!taskStatePreserved || !externalWritesReconciled)) {
  admitted = false
  reason = "broad_retry_or_restart_rejected_before_write_reconciliation"
  action = "checkpoint_task_and_reconcile_repository_connector_and_deployment_writes"
  exitCode = 64
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  host_pid: hostPid,
  host_creation_identity: hostCreationIdentity,
  mcp_pid: mcpPid,
  termination_method: terminationMethod,
  ownership_safe: ownershipSafe,
  containment_verified: containmentVerified,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
