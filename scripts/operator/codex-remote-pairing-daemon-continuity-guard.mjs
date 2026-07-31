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
  "approved_local_host_console",
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
let pairing
let daemon
let recovery
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  pairing = object(evidence.pairing, "pairing")
  daemon = object(evidence.daemon, "daemon")
  recovery = object(evidence.recovery, "recovery")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const mobilePlatform = nonEmptyString(pairing.mobile_platform, "pairing.mobile_platform").toLowerCase()
const mobileVersion = optionalString(pairing.mobile_version, "pairing.mobile_version")
const hostPlatform = nonEmptyString(pairing.host_platform, "pairing.host_platform").toLowerCase()
const cliVersion = optionalString(pairing.cli_version, "pairing.cli_version")
const browserAuthorizationCompleted = boolean(pairing.browser_authorization_completed, "pairing.browser_authorization_completed")
const returnedToApp = boolean(pairing.returned_to_app, "pairing.returned_to_app")
const pairingClaimsSeen = integer(pairing.pairing_claims_seen, "pairing.pairing_claims_seen")
const hostWebsocketConnected = boolean(pairing.host_websocket_connected, "pairing.host_websocket_connected")
const sameAccountVerified = boolean(pairing.same_account_verified, "pairing.same_account_verified")
const freshPairingCode = boolean(pairing.fresh_pairing_code, "pairing.fresh_pairing_code")
const authorizationAttempts = integer(pairing.authorization_attempts, "pairing.authorization_attempts")
const pairedDeviceReadback = boolean(pairing.paired_device_readback, "pairing.paired_device_readback")

const managedDaemonExpected = boolean(daemon.managed_daemon_expected, "daemon.managed_daemon_expected")
const managedDaemonRunning = boolean(daemon.managed_daemon_running, "daemon.managed_daemon_running")
const controlSocketOwnedByManagedDaemon = boolean(daemon.control_socket_owned_by_managed_daemon, "daemon.control_socket_owned_by_managed_daemon")
const genericAppServerPresent = boolean(daemon.generic_app_server_present, "daemon.generic_app_server_present")
const autoBootSuppressed = boolean(daemon.auto_boot_suppressed, "daemon.auto_boot_suppressed")
const unrelatedCodexCommandBeforeStart = boolean(daemon.unrelated_codex_command_before_start, "daemon.unrelated_codex_command_before_start")

const processInventoryCaptured = boolean(recovery.process_inventory_captured, "recovery.process_inventory_captured")
const exactSocketOwnerIdentified = boolean(recovery.exact_socket_owner_identified, "recovery.exact_socket_owner_identified")
const onlyStaleGenericServerStopped = boolean(recovery.only_stale_generic_server_stopped, "recovery.only_stale_generic_server_stopped")
const managedDaemonStartedFirst = boolean(recovery.managed_daemon_started_first, "recovery.managed_daemon_started_first")
const postStartHealthCanary = boolean(recovery.post_start_health_canary, "recovery.post_start_health_canary")
const repeatedAuthSuppressed = boolean(recovery.repeated_auth_suppressed, "recovery.repeated_auth_suppressed")
const broadProcessKillRequested = boolean(recovery.broad_process_kill_requested, "recovery.broad_process_kill_requested")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const hostWorkContinues = boolean(state.host_work_continues, "state.host_work_continues")
const threadReplayRequested = boolean(state.thread_replay_requested, "state.thread_replay_requested")
const newPairingIdentityRequested = boolean(state.new_pairing_identity_requested, "state.new_pairing_identity_requested")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const canaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && canaryPassed && operationBindingMatches && taskStatePreserved && externalWritesReconciled

const pairingLoop = browserAuthorizationCompleted && returnedToApp && pairingClaimsSeen === 0 && !pairedDeviceReadback
const hostHealthy = hostWebsocketConnected && sameAccountVerified && freshPairingCode
const daemonHealthy = !managedDaemonExpected || (managedDaemonRunning && controlSocketOwnedByManagedDaemon && !genericAppServerPresent)
const daemonRecoveryReady = processInventoryCaptured && exactSocketOwnerIdentified && onlyStaleGenericServerStopped && autoBootSuppressed && managedDaemonStartedFirst && postStartHealthCanary

let admitted = true
let reason = "remote_pairing_and_daemon_state_verified"
let action = "continue_remote_and_host_workflows"
let exitCode = 0

if (broadProcessKillRequested) {
  admitted = false
  reason = "broad_codex_process_kill_rejected"
  action = "inventory_processes_and_stop_only_the_exact_stale_generic_server_bound_to_the_control_socket"
  exitCode = 64
} else if ((threadReplayRequested || newPairingIdentityRequested) && (!taskStatePreserved || !externalWritesReconciled)) {
  admitted = false
  reason = "remote_replay_or_identity_replacement_rejected_before_reconciliation"
  action = "preserve_the_canonical_thread_pairing_receipts_and_reconcile_all_prior_writes"
  exitCode = 64
} else if (pairingLoop) {
  admitted = false
  reason = "mobile_authorization_completed_without_pairing_claim"
  action = repeatedAuthSuppressed && routeReady
    ? "isolate_only_mobile_remote_pairing_and_continue_host_work_through_the_verified_operation_bound_route"
    : "stop_repeating_authorization_preserve_pairing_evidence_and_continue_on_the_host_while_remote_pairing_is_isolated"
  exitCode = 75
} else if (!hostHealthy && authorizationAttempts > 0) {
  admitted = false
  reason = "host_remote_control_health_not_proven"
  action = "verify_same_account_fresh_pairing_code_and_relay_websocket_before_another_authorization_attempt"
  exitCode = 75
} else if (managedDaemonExpected && genericAppServerPresent) {
  admitted = false
  reason = "generic_app_server_occupies_managed_control_socket"
  action = daemonRecoveryReady
    ? "continue_after_exact_daemon_ownership_and_health_readback"
    : "suppress_auto_boot_stop_only_the_identified_generic_socket_owner_start_the_managed_daemon_first_and_verify_health"
  exitCode = 75
} else if (managedDaemonExpected && unrelatedCodexCommandBeforeStart) {
  admitted = false
  reason = "codex_command_retriggered_generic_auto_boot_before_daemon_start"
  action = "set_auto_boot_suppression_then_start_remote_control_daemon_before_running_any_other_codex_command"
  exitCode = 75
} else if (!daemonHealthy) {
  admitted = false
  reason = "managed_remote_control_daemon_not_authoritative"
  action = daemonRecoveryReady
    ? "verify_socket_owner_and_resume_remote_pairing_canary"
    : "repair_only_the_daemon_control_socket_boundary_and_keep_host_work_running"
  exitCode = 75
} else if (authorizationAttempts > 1 && !repeatedAuthSuppressed && !pairedDeviceReadback) {
  admitted = false
  reason = "repeated_authorization_attempts_suppressed"
  action = "retain_one_evidence_complete_attempt_and_avoid_more_browser_auth_loops_until_client_or_backend_changes"
  exitCode = 75
} else if (!hostWorkContinues && routeReady) {
  admitted = false
  reason = "host_work_unnecessarily_paused_for_remote_pairing_failure"
  action = "continue_the_exact_unfinished_host_operation_and_isolate_only_remote_mobile_access"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  mobile_platform: mobilePlatform,
  mobile_version: mobileVersion,
  host_platform: hostPlatform,
  cli_version: cliVersion,
  pairing_loop: pairingLoop,
  host_remote_health_verified: hostHealthy,
  daemon_authoritative: daemonHealthy,
  daemon_recovery_ready: daemonRecoveryReady,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
