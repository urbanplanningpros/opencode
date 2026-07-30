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

if (prohibited.test(JSON.stringify(evidence))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let taskId
let operationId
let threadId
let requestedMode
let clientMode
let toolMode
let injectedMode
let resume
let recovery

try {
  taskId = nonEmptyString(evidence.task_id, "task_id")
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  threadId = nonEmptyString(evidence.thread_id, "thread_id")
  requestedMode = nonEmptyString(evidence.requested_mode, "requested_mode").toLowerCase()
  clientMode = nonEmptyString(evidence.client_mode, "client_mode").toLowerCase()
  toolMode = nonEmptyString(evidence.tool_mode, "tool_mode").toLowerCase()
  injectedMode = nonEmptyString(evidence.injected_mode, "injected_mode").toLowerCase()
  resume = optionalObject(evidence.resume, "resume")
  recovery = optionalObject(evidence.recovery, "recovery")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const validModes = new Set(["default", "plan"])
if (![requestedMode, clientMode, toolMode, injectedMode].every((mode) => validModes.has(mode))) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_mode" }, null, 2))
  process.exit(2)
}

const resumed = boolean(resume.used, "resume.used")
const crossedVersion = boolean(resume.crossed_cli_version, "resume.crossed_cli_version")
const sourcePreserved = boolean(recovery.source_thread_preserved, "recovery.source_thread_preserved")
const snapshotHashed = boolean(recovery.state_snapshot_hashed, "recovery.state_snapshot_hashed")
const repositoryReconciled = boolean(recovery.repository_state_reconciled, "recovery.repository_state_reconciled")
const externalWritesReconciled = boolean(recovery.external_writes_reconciled, "recovery.external_writes_reconciled")
const mutationBlockedInAffectedThread = boolean(
  recovery.mutation_blocked_in_affected_thread,
  "recovery.mutation_blocked_in_affected_thread",
)
const checkpointExported = boolean(recovery.checkpoint_exported, "recovery.checkpoint_exported")
const freshThreadCreated = boolean(recovery.fresh_default_thread_created, "recovery.fresh_default_thread_created")
const automaticReplayAttempted = boolean(recovery.automatic_replay_attempted, "recovery.automatic_replay_attempted")
const forkOrContinueUsed = boolean(recovery.fork_or_continue_used, "recovery.fork_or_continue_used")
const continuationRoute = optionalString(recovery.continuation_route, "recovery.continuation_route").toLowerCase()

const stalePlanConstraint =
  resumed &&
  requestedMode === "default" &&
  clientMode === "default" &&
  (toolMode === "plan" || injectedMode === "plan")

const modeSplit = new Set([clientMode, toolMode, injectedMode]).size > 1
const safeRoutes = new Set(["fresh_default_thread", "approved_local", "approved_linux"])
const safeRouteSelected = safeRoutes.has(continuationRoute)
const freshThreadRouteValid = continuationRoute !== "fresh_default_thread" || freshThreadCreated
const recoveryComplete =
  sourcePreserved &&
  snapshotHashed &&
  repositoryReconciled &&
  externalWritesReconciled &&
  mutationBlockedInAffectedThread &&
  checkpointExported &&
  safeRouteSelected &&
  freshThreadRouteValid

let admitted = true
let reason = "plan_mode_resume_continuity_verified"
let exitCode = 0

if (automaticReplayAttempted || forkOrContinueUsed) {
  admitted = false
  reason = "replay_or_inherited_thread_continuation_forbidden"
  exitCode = 64
} else if (stalePlanConstraint || modeSplit) {
  if (!recoveryComplete) {
    admitted = false
    reason = stalePlanConstraint ? "stale_plan_mode_state_unreconciled" : "collaboration_mode_state_split"
    exitCode = 75
  } else {
    reason = "stale_plan_mode_isolated_and_rerouted"
  }
} else if (crossedVersion && resumed && !snapshotHashed) {
  admitted = false
  reason = "cross_version_resume_snapshot_missing"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  thread_id: threadId,
  stale_plan_constraint: stalePlanConstraint,
  mode_split: modeSplit,
  continuation_route: continuationRoute || "same_thread",
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
