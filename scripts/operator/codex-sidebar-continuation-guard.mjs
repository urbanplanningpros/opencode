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

let sourceThreadId
let operationId
let repositorySha
let diffSha256
let appBuild
let continuationMode
let continuationRoute
let sourceCheckpointSha256
let targetTaskId

try {
  sourceThreadId = nonEmptyString(evidence.source_thread_id, "source_thread_id")
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  repositorySha = nonEmptyString(evidence.repository_sha, "repository_sha")
  diffSha256 = nonEmptyString(evidence.diff_sha256, "diff_sha256")
  appBuild = optionalString(evidence.app_build, "app_build")
  continuationMode = nonEmptyString(evidence.continuation_mode, "continuation_mode").toLowerCase()
  continuationRoute = nonEmptyString(evidence.continuation_route, "continuation_route").toLowerCase()
  sourceCheckpointSha256 = optionalString(evidence.source_checkpoint_sha256, "source_checkpoint_sha256")
  targetTaskId = optionalString(evidence.target_task_id, "target_task_id")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (!new Set(["same_workspace", "new_worktree"]).has(continuationMode)) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_continuation_mode" }, null, 2))
  process.exit(2)
}

if (!new Set(["native", "checkpoint_same_workspace", "checkpoint_new_worktree", "approved_local", "approved_linux"]).has(continuationRoute)) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_continuation_route" }, null, 2))
  process.exit(2)
}

const continuationAttempted = boolean(evidence.continuation_attempted, "continuation_attempted")
const noRolloutFound = boolean(evidence.no_rollout_found, "no_rollout_found")
const sourceRolloutVerified = boolean(evidence.source_rollout_verified, "source_rollout_verified")
const sourceThreadPreserved = boolean(evidence.source_thread_preserved, "source_thread_preserved")
const sourceCheckpointExported = boolean(evidence.source_checkpoint_exported, "source_checkpoint_exported")
const targetTaskCreated = boolean(evidence.target_task_created, "target_task_created")
const targetTaskIndexed = boolean(evidence.target_task_indexed, "target_task_indexed")
const targetWorkspaceVerified = boolean(evidence.target_workspace_verified, "target_workspace_verified")
const targetWorktreeInitialized = boolean(evidence.target_worktree_initialized, "target_worktree_initialized")
const repositoryStateVerified = boolean(evidence.repository_state_verified, "repository_state_verified")
const externalWritesReconciled = boolean(evidence.external_writes_reconciled, "external_writes_reconciled")
const automaticRetryAttempted = boolean(evidence.automatic_retry_attempted, "automatic_retry_attempted")
const replacementTaskCreated = boolean(evidence.replacement_task_created, "replacement_task_created")
const duplicateContinuationCreated = boolean(evidence.duplicate_continuation_created, "duplicate_continuation_created")

const nativeRoute = continuationRoute === "native"
const checkpointRoute = new Set(["checkpoint_same_workspace", "checkpoint_new_worktree"]).has(continuationRoute)
const approvedExecutorRoute = new Set(["approved_local", "approved_linux"]).has(continuationRoute)
const newWorktreeRoute = continuationMode === "new_worktree" || continuationRoute === "checkpoint_new_worktree"

const unsafeReplay = automaticRetryAttempted || replacementTaskCreated || duplicateContinuationCreated
const identityBindingMissing = !sourceThreadPreserved || !repositoryStateVerified
const nativeContinuationUnavailable = continuationAttempted && nativeRoute && (noRolloutFound || !sourceRolloutVerified)
const checkpointBindingMissing = checkpointRoute && (!sourceCheckpointExported || !sourceCheckpointSha256)
const targetTaskMissing = checkpointRoute && (!targetTaskCreated || !targetTaskId || !targetTaskIndexed || !targetWorkspaceVerified)
const worktreeInitializationMissing = checkpointRoute && newWorktreeRoute && !targetWorktreeInitialized
const executorFallbackIncomplete = approvedExecutorRoute && (!sourceCheckpointExported || !sourceCheckpointSha256)

let admitted = true
let reason = "sidebar_continuation_verified"
let exitCode = 0

if (!continuationAttempted) {
  admitted = false
  reason = "continuation_not_attempted"
  exitCode = 2
} else if (!externalWritesReconciled) {
  admitted = false
  reason = "sidebar_continuation_writes_unreconciled"
  exitCode = 75
} else if (unsafeReplay) {
  admitted = false
  reason = "sidebar_continuation_replay_forbidden"
  exitCode = 64
} else if (identityBindingMissing) {
  admitted = false
  reason = "sidebar_continuation_source_state_unverified"
  exitCode = 75
} else if (nativeContinuationUnavailable) {
  admitted = false
  reason = "sidebar_continuation_rollout_unavailable"
  exitCode = 75
} else if (checkpointBindingMissing || targetTaskMissing || worktreeInitializationMissing) {
  admitted = false
  reason = "sidebar_continuation_checkpoint_unverified"
  exitCode = 75
} else if (executorFallbackIncomplete) {
  admitted = false
  reason = "sidebar_continuation_executor_fallback_unverified"
  exitCode = 75
}

const report = {
  admitted,
  reason,
  app_build: appBuild || null,
  source_thread_id: sourceThreadId,
  operation_id: operationId,
  repository_sha: repositorySha,
  diff_sha256: diffSha256,
  continuation_mode: continuationMode,
  continuation_route: continuationRoute,
  no_rollout_found: noRolloutFound,
  source_rollout_verified: sourceRolloutVerified,
  source_thread_preserved: sourceThreadPreserved,
  source_checkpoint_exported: sourceCheckpointExported,
  source_checkpoint_sha256: sourceCheckpointSha256 || null,
  target_task_created: targetTaskCreated,
  target_task_id: targetTaskId || null,
  target_task_indexed: targetTaskIndexed,
  target_workspace_verified: targetWorkspaceVerified,
  target_worktree_initialized: targetWorktreeInitialized,
  repository_state_verified: repositoryStateVerified,
  external_writes_reconciled: externalWritesReconciled,
  automatic_retry_attempted: automaticRetryAttempted,
  replacement_task_created: replacementTaskCreated,
  duplicate_continuation_created: duplicateContinuationCreated,
  protocol: admitted
    ? "Continue only the exact unfinished action. Keep the source thread, operation ledger, repository state, checkpoint hash, and verified target workspace authoritative."
    : "Stop only the failed continuation path. Preserve the source thread. Reconcile external writes. Do not retry Continue in a new task after a no-rollout error. Export a compact checkpoint, create one explicitly bound target task or use the approved local/Linux executor, verify repository state, and resume only the exact unfinished action.",
  resume_condition:
    "Resume after the source thread and repository state are verified, external writes are reconciled, and either the native rollout is available or one checkpoint-bound target/approved executor route is verified without replay or duplicate task creation.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
