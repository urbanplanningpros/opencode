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

function integer(value, name, fallback = 0) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function object(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_local_non_cua_executor",
])

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
let computerUse
let containment
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  computerUse = object(evidence.computer_use, "computer_use")
  containment = object(evidence.containment, "containment")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const platform = nonEmptyString(computerUse.platform, "computer_use.platform").toLowerCase()
const appVersion = optionalString(computerUse.app_version, "computer_use.app_version")
const userDisabled = boolean(computerUse.user_disabled, "computer_use.user_disabled")
const workspaceDisabled = boolean(computerUse.workspace_disabled, "computer_use.workspace_disabled")
const pluginDisabled = boolean(computerUse.plugin_disabled, "computer_use.plugin_disabled")
const runtimeCapabilityRegistered = boolean(computerUse.runtime_capability_registered, "computer_use.runtime_capability_registered")
const actionObservedAfterDisable = boolean(computerUse.action_observed_after_disable, "computer_use.action_observed_after_disable")
const disableReadbackVerified = boolean(computerUse.disable_readback_verified, "computer_use.disable_readback_verified")
const freshProcessVerified = boolean(computerUse.fresh_process_verified, "computer_use.fresh_process_verified")
const pendingActions = integer(computerUse.pending_actions, "computer_use.pending_actions")
const requestedActionCount = integer(computerUse.requested_action_count, "computer_use.requested_action_count")

const onlyCuaRouteIsolated = boolean(containment.only_cua_route_isolated, "containment.only_cua_route_isolated")
const executorStopped = boolean(containment.executor_stopped, "containment.executor_stopped")
const capabilityCatalogRefreshed = boolean(containment.capability_catalog_refreshed, "containment.capability_catalog_refreshed")
const osPermissionRevoked = boolean(containment.os_permission_revoked, "containment.os_permission_revoked")
const networkBoundaryApplied = boolean(containment.network_boundary_applied, "containment.network_boundary_applied")
const killSwitchReceipt = optionalString(containment.kill_switch_receipt, "containment.kill_switch_receipt")
const broadHostShutdownRequested = boolean(containment.broad_host_shutdown_requested, "containment.broad_host_shutdown_requested")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const replayRequested = boolean(state.replay_requested, "state.replay_requested")
const replacementThreadRequested = boolean(state.replacement_thread_requested, "state.replacement_thread_requested")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const canaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const computerUseAbsent = boolean(continuity.computer_use_absent, "continuity_route.computer_use_absent")
const routeReady = approvedRoutes.has(routeType) && routeVerified && canaryPassed && operationBindingMatches && computerUseAbsent && taskStatePreserved && externalWritesReconciled

const disabledByPolicy = userDisabled || workspaceDisabled || pluginDisabled
const disableBoundaryVerified = disabledByPolicy && disableReadbackVerified && freshProcessVerified
const contained = onlyCuaRouteIsolated && executorStopped && capabilityCatalogRefreshed && killSwitchReceipt !== "" && (osPermissionRevoked || networkBoundaryApplied)
const unsafePersistence = disabledByPolicy && (runtimeCapabilityRegistered || actionObservedAfterDisable)

let admitted = true
let reason = "computer_use_policy_and_runtime_agree"
let action = "continue_with_current_capability_set"
let exitCode = 0

if (broadHostShutdownRequested) {
  admitted = false
  reason = "broad_host_shutdown_rejected"
  action = "isolate_only_the_computer_use_executor_and_preserve_unaffected_workflows"
  exitCode = 64
} else if ((replayRequested || replacementThreadRequested) && (!taskStatePreserved || !externalWritesReconciled)) {
  admitted = false
  reason = "replay_or_replacement_rejected_before_write_reconciliation"
  action = "preserve_the_canonical_thread_and_reconcile_all_prior_mutations"
  exitCode = 64
} else if (actionObservedAfterDisable) {
  admitted = false
  reason = "computer_use_executed_after_disable"
  action = contained
    ? "keep_computer_use_quarantined_and_continue_the_exact_unfinished_work_through_the_verified_non_cua_route"
    : "stop_the_computer_use_executor_revoke_its_os_or_network_authority_refresh_the_catalog_and_bind_a_kill_switch_receipt"
  exitCode = 77
} else if (disabledByPolicy && !disableBoundaryVerified) {
  admitted = false
  reason = "computer_use_disable_not_proven_at_runtime_boundary"
  action = "restart_or_refresh_the_affected_surface_then_read_back_policy_and_runtime_capability_state"
  exitCode = 75
} else if (disabledByPolicy && runtimeCapabilityRegistered) {
  admitted = false
  reason = "computer_use_capability_remains_registered_while_disabled"
  action = contained
    ? "continue_without_computer_use_through_the_verified_operation_bound_route"
    : "remove_the_runtime_capability_stop_the_executor_and_apply_a_narrow_os_or_network_kill_switch"
  exitCode = 77
} else if (disabledByPolicy && pendingActions > 0) {
  admitted = false
  reason = "pending_computer_use_actions_exist_after_disable"
  action = "cancel_only_pending_computer_use_actions_preserve_the_task_and_reconcile_any_observed_external_effects"
  exitCode = 75
} else if (disabledByPolicy && requestedActionCount > 0 && !routeReady) {
  admitted = false
  reason = "disabled_computer_use_request_requires_verified_non_cua_continuity_route"
  action = "continue_read_only_or_shell_api_work_only_after_a_non_cua_canary_and_operation_binding_pass"
  exitCode = 75
} else if (unsafePersistence && !contained) {
  admitted = false
  reason = "computer_use_disable_boundary_not_contained"
  action = "quarantine_only_the_computer_use_route_and_preserve_all_other_business_critical_execution"
  exitCode = 77
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  platform,
  app_version: appVersion,
  disabled_by_policy: disabledByPolicy,
  disable_boundary_verified: disableBoundaryVerified,
  runtime_capability_registered: runtimeCapabilityRegistered,
  action_observed_after_disable: actionObservedAfterDisable,
  containment_ready: contained,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
