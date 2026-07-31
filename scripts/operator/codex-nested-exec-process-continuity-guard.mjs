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

function array(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_api", "direct_openai_app_server", "approved_local_openai"])
const terminalStatuses = new Set(["completed", "failed", "cancelled", "terminated", "closed"])
const liveStatuses = new Set(["running", "yielded", "waiting", "unknown"])

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
let parentExecutionId
let nestedExecs
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  parentExecutionId = nonEmptyString(evidence.parent_execution_id, "parent_execution_id")
  nestedExecs = array(evidence.nested_execs, "nested_execs")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const parentCompletionRequested = boolean(state.parent_completion_requested, "state.parent_completion_requested")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const newMutationRequested = boolean(state.new_mutation_requested, "state.new_mutation_requested")
const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const filesystemStatePreserved = boolean(state.filesystem_state_preserved, "state.filesystem_state_preserved")
const workspaceSnapshotRecorded = boolean(state.workspace_snapshot_recorded, "state.workspace_snapshot_recorded")
const gitCheckpointCreated = boolean(state.git_checkpoint_created, "state.git_checkpoint_created")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const exactChildTerminationRequested = boolean(state.exact_child_termination_requested, "state.exact_child_termination_requested")
const broadProcessKillRequested = boolean(state.broad_process_kill_requested, "state.broad_process_kill_requested")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const routeCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")

const routeReady =
  approvedRoutes.has(routeType) &&
  routeVerified &&
  routeCanaryPassed &&
  operationBindingMatches &&
  taskStatePreserved &&
  filesystemStatePreserved &&
  externalWritesReconciled

const liveChildren = []
const lostHandles = []
const falseCompletions = []
const unreconciledWrites = []
const unownedChildren = []
const terminationIdentityFailures = []

try {
  for (let index = 0; index < nestedExecs.length; index += 1) {
    const entry = object(nestedExecs[index], `nested_execs[${index}]`)
    const callId = nonEmptyString(entry.call_id, `nested_execs[${index}].call_id`)
    const commandClass = optionalString(entry.command_class, `nested_execs[${index}].command_class`).toLowerCase()
    if (!new Set(["read_only", "mutating"]).has(commandClass)) {
      throw new Error(`nested_execs[${index}].command_class must be read_only or mutating`)
    }

    const outerStatus = optionalString(entry.outer_status, `nested_execs[${index}].outer_status`).toLowerCase()
    const childStatus = optionalString(entry.child_status, `nested_execs[${index}].child_status`).toLowerCase()
    const sessionId = optionalString(entry.session_id, `nested_execs[${index}].session_id`)
    const sessionIdRetained = boolean(entry.session_id_retained, `nested_execs[${index}].session_id_retained`)
    const childProcessAlive = boolean(entry.child_process_alive, `nested_execs[${index}].child_process_alive`)
    const processHandleOwned = boolean(entry.process_handle_owned, `nested_execs[${index}].process_handle_owned`)
    const exactProcessIdentityVerified = boolean(entry.exact_process_identity_verified, `nested_execs[${index}].exact_process_identity_verified`)
    const writesReconciled = boolean(entry.writes_reconciled, `nested_execs[${index}].writes_reconciled`)
    const completionReceipt = boolean(entry.completion_receipt, `nested_execs[${index}].completion_receipt`)

    const childLive = childProcessAlive || liveStatuses.has(childStatus) || !terminalStatuses.has(childStatus)
    const outerTerminal = terminalStatuses.has(outerStatus)
    const mutationCapable = commandClass === "mutating"

    if (childLive) liveChildren.push(callId)
    if (childLive && (!sessionId || !sessionIdRetained)) lostHandles.push(callId)
    if (outerTerminal && childLive) falseCompletions.push(callId)
    if (mutationCapable && (!writesReconciled || (childLive && !completionReceipt))) unreconciledWrites.push(callId)
    if (childProcessAlive && !processHandleOwned && !exactProcessIdentityVerified) unownedChildren.push(callId)
    if (exactChildTerminationRequested && childProcessAlive && !processHandleOwned && !exactProcessIdentityVerified) {
      terminationIdentityFailures.push(callId)
    }
  }
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_nested_exec_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const unresolved = new Set([...liveChildren, ...lostHandles, ...falseCompletions, ...unreconciledWrites, ...unownedChildren])
const hasOrphanRisk = lostHandles.length > 0 || falseCompletions.length > 0 || unownedChildren.length > 0
const preservationReady = workspaceSnapshotRecorded && gitCheckpointCreated && taskStatePreserved && filesystemStatePreserved

let admitted = true
let reason = "nested_exec_lifecycle_verified"
let action = "continue_normally"
let exitCode = 0

if (broadProcessKillRequested) {
  admitted = false
  reason = "broad_process_kill_rejected"
  action = "terminate_only_an_exact_owned_child_process_or_job"
  exitCode = 64
} else if (terminationIdentityFailures.length > 0) {
  admitted = false
  reason = "exact_child_termination_requires_owned_process_identity"
  action = "recover_the_session_handle_or_verify_the_exact_process_identity"
  exitCode = 64
} else if (automaticReplayRequested && unresolved.size > 0) {
  admitted = false
  reason = "automatic_replay_rejected_with_live_or_unreconciled_nested_exec"
  action = "preserve_state_and_reconcile_the_exact_unfinished_operation"
  exitCode = 64
} else if (parentCompletionRequested && unresolved.size > 0) {
  admitted = false
  reason = "parent_completion_blocked_by_live_nested_exec"
  action = "retain_the_child_handle_wait_for_terminal_state_and_reconcile_writes"
  exitCode = 75
} else if (newMutationRequested && unresolved.size > 0) {
  admitted = false
  reason = "new_mutation_blocked_until_nested_exec_reconciled"
  action = "quarantine_only_the_affected_workspace_and_continue_independent_work"
  exitCode = 75
} else if (hasOrphanRisk && !preservationReady) {
  admitted = false
  reason = "orphaned_nested_exec_requires_filesystem_checkpoint"
  action = "record_git_status_head_index_lock_and_filesystem_snapshot_before_recovery"
  exitCode = 75
} else if (hasOrphanRisk && !routeReady) {
  admitted = false
  reason = "orphaned_nested_exec_requires_verified_continuity_route"
  action = "verify_a_direct_openai_or_approved_local_route_before_continuation"
  exitCode = 75
} else if (hasOrphanRisk && routeReady) {
  reason = "orphaned_nested_exec_contained"
  action = "continue_independent_work_without_replaying_or_mutating_the_affected_workspace"
} else if (liveChildren.length > 0) {
  reason = "live_nested_exec_tracked"
  action = "retain_session_ids_and_explicitly_wait_or_close_before_parent_completion"
} else if (unreconciledWrites.length > 0) {
  admitted = false
  reason = "nested_exec_writes_not_reconciled"
  action = "compare_git_and_filesystem_state_before_accepting_completion"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  parent_execution_id: parentExecutionId,
  live_children: [...new Set(liveChildren)].sort(),
  lost_handles: [...new Set(lostHandles)].sort(),
  false_completions: [...new Set(falseCompletions)].sort(),
  unreconciled_writes: [...new Set(unreconciledWrites)].sort(),
  unowned_children: [...new Set(unownedChildren)].sort(),
  route_type: routeType,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
