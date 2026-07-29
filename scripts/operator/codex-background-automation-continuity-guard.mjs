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
let remote

try {
  taskId = nonEmptyString(evidence.task_id, "task_id")
  automationId = nonEmptyString(evidence.automation_id, "automation_id")
  automationType = nonEmptyString(evidence.automation_type, "automation_type")
  executionEnvironment = nonEmptyString(evidence.execution_environment, "execution_environment").toLowerCase()
  repositoryBacked = boolean(evidence.repository_backed, "repository_backed")
  writesRepository = boolean(evidence.writes_repository, "writes_repository")
  savedConfigurationReadBack = boolean(evidence.saved_configuration_read_back, "saved_configuration_read_back")
  runtimeWorktreeObserved = boolean(evidence.runtime_worktree_observed, "runtime_worktree_observed")
  uncertainWritesReconciled = boolean(evidence.uncertain_writes_reconciled, "uncertain_writes_reconciled")
  approval = optionalObject(evidence.pending_approval, "pending_approval")
  remote = optionalObject(evidence.remote_connection, "remote_connection")
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

const approvalBlocking = approval.blocking === true
const approvalEventType = typeof approval.event_type === "string" ? approval.event_type.trim() : ""
const exactApprovalVisible = approval.exact_request_visible === true
const actionableNotificationObserved = approval.actionable_notification_observed === true
const approvalWatchdogActive = approval.approval_watchdog_active === true
const approvalRequestId = typeof approval.request_id === "string" ? approval.request_id.trim() : ""
const approvalOperationId = typeof approval.operation_id === "string" ? approval.operation_id.trim() : ""
const approvalPayloadHash = typeof approval.payload_sha256 === "string" ? approval.payload_sha256.trim() : ""
const approvalExpiry = typeof approval.expires_at === "string" ? approval.expires_at.trim() : ""
const approvalBindingMissing =
  approvalBlocking && (!approvalRequestId || !approvalOperationId || !approvalPayloadHash || !approvalExpiry)
const approvalSurfaceMissing = approvalBlocking && !exactApprovalVisible
const approvalAttentionMissing =
  approvalBlocking && !actionableNotificationObserved && !approvalWatchdogActive

const remoteUsed = remote.used === true
const remoteEndpointReachable = remote.endpoint_reachable === true
const remoteAppReconnected = remote.app_reconnected === true
const remoteTaskIdentityVerified = remote.task_identity_verified === true
const remoteStateVerified = remote.state_verified === true
const remoteRecoveryMissing =
  remoteUsed && remoteEndpointReachable && (!remoteAppReconnected || !remoteTaskIdentityVerified || !remoteStateVerified)

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
} else if (worktreeIsolationMissing) {
  admitted = false
  reason = "repository_writing_automation_not_isolated"
  exitCode = 75
} else if (worktreeEvidenceMissing) {
  admitted = false
  reason = "worktree_configuration_or_runtime_unverified"
  exitCode = 75
} else if (approvalAttentionMissing) {
  admitted = false
  reason = "blocking_approval_has_no_actionable_attention_route"
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
  },
  protocol: admitted
    ? "Continue the isolated automation. Keep the saved worktree configuration, approval watchdog, exact payload-bound approval, task identity, operation ID, idempotency key, and external state ledger authoritative."
    : "Stop only the affected automation turn. Preserve task state, repository SHA, diff hash, operation ID, idempotency key, and pending approval evidence. Reconcile uncertain writes. For repository-writing cron jobs, preserve an existing Worktree automation through the supported update path and read it back, or use the explicitly authorized local scheduler to create an isolated temporary worktree. For hidden MCP approvals, surface the exact request through a foreground or read-only watchdog route; never auto-approve. When a remote endpoint returns, reconnect once and verify the same task and repository state before resuming.",
  resume_condition:
    "Resume only after repository-writing cron execution is verified in an isolated worktree, every blocking approval is exact and visible through an actionable notification or active watchdog, remote task identity and state are verified after reconnection, and all uncertain writes are reconciled.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
