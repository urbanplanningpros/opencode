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

function optionalObject(value, name) {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i

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

const routingMetadata = JSON.stringify({
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
  evidence,
})

if (prohibited.test(routingMetadata)) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let taskId
let automationId
let automationType
let executionEnvironment
let repositoryBacked
let writesRepository
let savedConfigurationReadBack
let runtimeWorktreeObserved
let uncertainWritesReconciled
let approval
let scheduled
let remote
let worktreeEnvironment
let appServer
let handoff

try {
  taskId = nonEmptyString(evidence.task_id, "task_id")
  automationId = nonEmptyString(evidence.automation_id, "automation_id")
  automationType = nonEmptyString(evidence.automation_type, "automation_type").toLowerCase()
  executionEnvironment = nonEmptyString(evidence.execution_environment, "execution_environment").toLowerCase()
  repositoryBacked = boolean(evidence.repository_backed, "repository_backed")
  writesRepository = boolean(evidence.writes_repository, "writes_repository")
  savedConfigurationReadBack = boolean(evidence.saved_configuration_read_back, "saved_configuration_read_back")
  runtimeWorktreeObserved = boolean(evidence.runtime_worktree_observed, "runtime_worktree_observed")
  uncertainWritesReconciled = boolean(evidence.uncertain_writes_reconciled, "uncertain_writes_reconciled")
  approval = optionalObject(evidence.pending_approval, "pending_approval")
  scheduled = optionalObject(evidence.scheduled_execution, "scheduled_execution")
  remote = optionalObject(evidence.remote_connection, "remote_connection")
  worktreeEnvironment = optionalObject(evidence.worktree_environment, "worktree_environment")
  appServer = optionalObject(evidence.app_server, "app_server")
  handoff = optionalObject(evidence.context_handoff, "context_handoff")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (!new Set(["cron", "heartbeat", "manual"]).has(automationType)) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_automation_type" }, null, 2))
  process.exit(2)
}

if (!new Set(["local", "worktree", "none"]).has(executionEnvironment)) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_execution_environment" }, null, 2))
  process.exit(2)
}

const requiresWorktree = automationType === "cron" && repositoryBacked && writesRepository
const worktreeIsolationMissing = requiresWorktree && executionEnvironment !== "worktree"
const worktreeEvidenceMissing =
  requiresWorktree && executionEnvironment === "worktree" && (!savedConfigurationReadBack || !runtimeWorktreeObserved)

const delegatedWorktreeCreation = worktreeEnvironment.delegated_or_programmatic_creation === true
const selectedEnvironmentBound = worktreeEnvironment.selected_environment_bound === true
const setupScriptRequired = worktreeEnvironment.setup_script_required === true
const setupScriptCompleted = worktreeEnvironment.setup_script_completed === true
const expectedSetupArtifactsVerified = worktreeEnvironment.expected_artifacts_verified === true
const environmentManagerReady = worktreeEnvironment.environment_manager_ready === true
const delegatedWorktreeEnvironmentUnverified =
  requiresWorktree &&
  executionEnvironment === "worktree" &&
  delegatedWorktreeCreation &&
  (!selectedEnvironmentBound ||
    !environmentManagerReady ||
    (setupScriptRequired && (!setupScriptCompleted || !expectedSetupArtifactsVerified)))

const localScheduledRun = automationType === "cron" && executionEnvironment === "local"
const backgroundDriverVerified = boolean(scheduled.background_driver_verified, "scheduled_execution.background_driver_verified")
const firstToolStarted = boolean(scheduled.first_tool_started, "scheduled_execution.first_tool_started")
const progressHeartbeatObserved = boolean(
  scheduled.progress_heartbeat_observed,
  "scheduled_execution.progress_heartbeat_observed",
)
const manualResumeRequired = boolean(scheduled.manual_resume_required, "scheduled_execution.manual_resume_required")
const sameThreadResumeOnly = boolean(scheduled.same_thread_resume_only, "scheduled_execution.same_thread_resume_only")
const localBackgroundExecutionUnverified =
  localScheduledRun && (!backgroundDriverVerified || !firstToolStarted || !progressHeartbeatObserved)
const localScheduledRunStalled = localScheduledRun && manualResumeRequired
const localResumeUnsafe = localScheduledRunStalled && !sameThreadResumeOnly

const approvalBlocking = approval.blocking === true
const approvalEventType = optionalString(approval.event_type, "pending_approval.event_type")
const exactApprovalVisible = approval.exact_request_visible === true
const actionableNotificationObserved = approval.actionable_notification_observed === true
const approvalWatchdogActive = approval.approval_watchdog_active === true
const approvalRequestId = optionalString(approval.request_id, "pending_approval.request_id")
const approvalOperationId = optionalString(approval.operation_id, "pending_approval.operation_id")
const approvalPayloadHash = optionalString(approval.payload_sha256, "pending_approval.payload_sha256")
const approvalExpiry = optionalString(approval.expires_at, "pending_approval.expires_at")
const approvalBindingMissing =
  approvalBlocking && (!approvalRequestId || !approvalOperationId || !approvalPayloadHash || !approvalExpiry)
const approvalSurfaceMissing = approvalBlocking && !exactApprovalVisible
const approvalAttentionMissing = approvalBlocking && !actionableNotificationObserved && !approvalWatchdogActive

const remoteUsed = remote.used === true
const remoteEndpointReachable = remote.endpoint_reachable === true
const remoteAppReconnected = remote.app_reconnected === true
const remoteTaskIdentityVerified = remote.task_identity_verified === true
const remoteStateVerified = remote.state_verified === true
const remoteSequenceGapDetected = remote.sequence_gap_detected === true
const remoteCanonicalState = optionalString(remote.canonical_host_state, "remote_connection.canonical_host_state").toLowerCase()
const remoteCanonicalStateReconciled = remote.canonical_state_reconciled === true
const remoteControllerProjectionResynced = remote.controller_projection_resynced === true
const remoteResumeAttempted = remote.resume_attempted === true
const remoteRecoveryMissing =
  remoteUsed && remoteEndpointReachable && (!remoteAppReconnected || !remoteTaskIdentityVerified || !remoteStateVerified)
const remoteSequenceStateInvalid =
  remoteSequenceGapDetected && !new Set(["active", "completed"]).has(remoteCanonicalState)
const remoteSequenceNotReconciled =
  remoteSequenceGapDetected && (!remoteTaskIdentityVerified || !remoteCanonicalStateReconciled)
const completedRemoteReplayAttempted =
  remoteSequenceGapDetected && remoteCanonicalState === "completed" && remoteResumeAttempted
const remoteControllerProjectionStale =
  remoteSequenceGapDetected && remoteCanonicalState === "completed" && !remoteControllerProjectionResynced

const appServerUsed = appServer.used === true
const appServerUnexpectedExit = appServer.unexpected_exit === true
const appServerExitSignal = optionalString(appServer.unexpected_exit_signal, "app_server.unexpected_exit_signal").toUpperCase()
const destroyedStdinObserved = appServer.destroyed_stdin_observed === true
const appServerFailureDetected =
  appServerUsed && (appServerUnexpectedExit || appServerExitSignal !== "" || destroyedStdinObserved)
const extensionHostRestarted = appServer.extension_host_restarted === true
const canonicalTurnStateReconciled = appServer.canonical_turn_state_reconciled === true
const externalCommandStateReconciled = appServer.external_command_state_reconciled === true
const appServerAutomaticReplayAttempted = appServer.automatic_replay_attempted === true
const appServerReplacementSessionCreated = appServer.replacement_session_created === true
const appServerContinuationRoute = optionalString(
  appServer.continuation_route,
  "app_server.continuation_route",
).toLowerCase()
const appServerApprovedExternalRoute = new Set(["approved_local", "approved_linux"]).has(appServerContinuationRoute)
const appServerContinuationRouteValid = new Set(["same_thread", "approved_local", "approved_linux"]).has(
  appServerContinuationRoute,
)
const appServerControlSurfaceRecovered = extensionHostRestarted || appServerApprovedExternalRoute
const appServerUnsafeReplay =
  appServerFailureDetected && (appServerAutomaticReplayAttempted || appServerReplacementSessionCreated)
const appServerRecoveryMissing =
  appServerFailureDetected &&
  (!appServerControlSurfaceRecovered ||
    !canonicalTurnStateReconciled ||
    !externalCommandStateReconciled ||
    !appServerContinuationRouteValid)

const handoffUsed = handoff.used === true
const handoffLargeContext = handoff.large_context === true
const handoffDirectMigrationAttempted = handoff.direct_work_migration_attempted === true
const handoffManualCheckpointRouteUsed = handoff.manual_checkpoint_route_used === true
const handoffSourceCheckpointExported = handoff.source_checkpoint_exported === true
const handoffSourceThreadPreserved = handoff.source_thread_preserved === true
const handoffTargetThreadCreated = handoff.target_thread_created === true
const handoffTargetThreadIndexed = handoff.target_thread_indexed === true
const handoffRendererHealthy = handoff.renderer_healthy === true
const handoffAutomaticReplayAttempted = handoff.automatic_replay_attempted === true
const largeContextDirectMigrationUntrusted =
  handoffUsed && handoffLargeContext && handoffDirectMigrationAttempted && !handoffManualCheckpointRouteUsed
const largeContextCheckpointIncomplete =
  handoffUsed &&
  handoffLargeContext &&
  handoffManualCheckpointRouteUsed &&
  (!handoffSourceCheckpointExported ||
    !handoffSourceThreadPreserved ||
    !handoffTargetThreadCreated ||
    !handoffTargetThreadIndexed ||
    !handoffRendererHealthy)
const handoffUnsafeReplay = handoffUsed && handoffAutomaticReplayAttempted

let admitted = true
let reason = "background_automation_continuity_verified"
let exitCode = 0

if (!uncertainWritesReconciled) {
  admitted = false
  reason = "uncertain_writes_not_reconciled"
  exitCode = 75
} else if (approvalBindingMissing || approvalSurfaceMissing) {
  admitted = false
  reason = approvalBindingMissing ? "approval_binding_incomplete" : "approval_request_not_visible"
  exitCode = 64
} else if (
  completedRemoteReplayAttempted ||
  localResumeUnsafe ||
  appServerUnsafeReplay ||
  handoffUnsafeReplay
) {
  admitted = false
  reason = completedRemoteReplayAttempted
    ? "completed_remote_task_resume_forbidden"
    : localResumeUnsafe
      ? "stalled_local_task_must_resume_same_thread"
      : appServerUnsafeReplay
        ? "app_server_failure_replay_forbidden"
        : "context_handoff_replay_forbidden"
  exitCode = 64
} else if (worktreeIsolationMissing) {
  admitted = false
  reason = "repository_writing_automation_not_isolated"
  exitCode = 75
} else if (worktreeEvidenceMissing) {
  admitted = false
  reason = "worktree_configuration_or_runtime_unverified"
  exitCode = 75
} else if (delegatedWorktreeEnvironmentUnverified) {
  admitted = false
  reason = "delegated_worktree_environment_uninitialized"
  exitCode = 75
} else if (appServerRecoveryMissing) {
  admitted = false
  reason = "app_server_failure_state_unreconciled"
  exitCode = 75
} else if (largeContextDirectMigrationUntrusted) {
  admitted = false
  reason = "large_context_direct_work_handoff_untrusted"
  exitCode = 75
} else if (largeContextCheckpointIncomplete) {
  admitted = false
  reason = "large_context_checkpoint_handoff_unverified"
  exitCode = 75
} else if (localScheduledRunStalled) {
  admitted = false
  reason = "local_scheduled_run_requires_foreground_resume"
  exitCode = 75
} else if (localBackgroundExecutionUnverified) {
  admitted = false
  reason = "local_scheduled_background_execution_unverified"
  exitCode = 75
} else if (approvalAttentionMissing) {
  admitted = false
  reason = "blocking_approval_has_no_actionable_attention_route"
  exitCode = 75
} else if (remoteSequenceStateInvalid) {
  admitted = false
  reason = "remote_canonical_state_unknown_after_sequence_gap"
  exitCode = 75
} else if (remoteSequenceNotReconciled) {
  admitted = false
  reason = "remote_sequence_gap_not_reconciled"
  exitCode = 75
} else if (remoteControllerProjectionStale) {
  admitted = false
  reason = "remote_controller_projection_stale"
  exitCode = 75
} else if (remoteRecoveryMissing) {
  admitted = false
  reason = "remote_connection_restored_but_codex_state_unverified"
  exitCode = 75
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  automation_id: automationId,
  automation_type: automationType,
  repository_backed: repositoryBacked,
  writes_repository: writesRepository,
  execution_environment: executionEnvironment,
  requires_worktree: requiresWorktree,
  saved_configuration_read_back: savedConfigurationReadBack,
  runtime_worktree_observed: runtimeWorktreeObserved,
  worktree_environment: {
    delegated_or_programmatic_creation: delegatedWorktreeCreation,
    selected_environment_bound: selectedEnvironmentBound,
    setup_script_required: setupScriptRequired,
    setup_script_completed: setupScriptCompleted,
    expected_artifacts_verified: expectedSetupArtifactsVerified,
    environment_manager_ready: environmentManagerReady,
  },
  scheduled_execution: {
    local_scheduled_run: localScheduledRun,
    background_driver_verified: backgroundDriverVerified,
    first_tool_started: firstToolStarted,
    progress_heartbeat_observed: progressHeartbeatObserved,
    manual_resume_required: manualResumeRequired,
    same_thread_resume_only: sameThreadResumeOnly,
  },
  pending_approval: {
    blocking: approvalBlocking,
    event_type: approvalEventType || null,
    exact_request_visible: exactApprovalVisible,
    actionable_notification_observed: actionableNotificationObserved,
    approval_watchdog_active: approvalWatchdogActive,
    request_id: approvalRequestId || null,
    operation_id: approvalOperationId || null,
    payload_sha256: approvalPayloadHash || null,
    expires_at: approvalExpiry || null,
  },
  remote_connection: {
    used: remoteUsed,
    endpoint_reachable: remoteEndpointReachable,
    app_reconnected: remoteAppReconnected,
    task_identity_verified: remoteTaskIdentityVerified,
    state_verified: remoteStateVerified,
    sequence_gap_detected: remoteSequenceGapDetected,
    canonical_host_state: remoteCanonicalState || null,
    canonical_state_reconciled: remoteCanonicalStateReconciled,
    controller_projection_resynced: remoteControllerProjectionResynced,
    resume_attempted: remoteResumeAttempted,
  },
  app_server: {
    used: appServerUsed,
    failure_detected: appServerFailureDetected,
    unexpected_exit_signal: appServerExitSignal || null,
    destroyed_stdin_observed: destroyedStdinObserved,
    extension_host_restarted: extensionHostRestarted,
    canonical_turn_state_reconciled: canonicalTurnStateReconciled,
    external_command_state_reconciled: externalCommandStateReconciled,
    automatic_replay_attempted: appServerAutomaticReplayAttempted,
    replacement_session_created: appServerReplacementSessionCreated,
    continuation_route: appServerContinuationRoute || null,
  },
  context_handoff: {
    used: handoffUsed,
    large_context: handoffLargeContext,
    direct_work_migration_attempted: handoffDirectMigrationAttempted,
    manual_checkpoint_route_used: handoffManualCheckpointRouteUsed,
    source_checkpoint_exported: handoffSourceCheckpointExported,
    source_thread_preserved: handoffSourceThreadPreserved,
    target_thread_created: handoffTargetThreadCreated,
    target_thread_indexed: handoffTargetThreadIndexed,
    renderer_healthy: handoffRendererHealthy,
    automatic_replay_attempted: handoffAutomaticReplayAttempted,
  },
  protocol: admitted
    ? "Continue the isolated automation. Keep the saved worktree configuration and initialized environment, verified background driver, progress heartbeat, exact payload-bound approval, canonical host and app-server task state, operation ID, idempotency key, and external state ledger authoritative."
    : "Stop only the affected turn. Preserve task state, repository SHA, diff hash, operation ID, idempotency key, environment receipt, and pending approval evidence. Reconcile uncertain writes. For delegated worktrees, bind the selected environment and verify setup artifacts before commands run. After app-server failure, recover the same task or use the approved local/Linux route only after canonical turn and external command state are reconciled. For large-context Chat-to-Work handoff, use a compact manual checkpoint rather than replaying the direct migration. Never resume a host-completed task.",
  resume_condition:
    "Resume only after repository-writing cron execution is verified in an isolated, initialized worktree; Local scheduled execution has a verified background driver, first tool start, and progress heartbeat or has been safely moved to the authorized scheduler; every blocking approval is exact and visible; app-server or Remote Control failures are reconciled without replay; large-context handoffs use a verified checkpoint route; and all uncertain writes are reconciled.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
