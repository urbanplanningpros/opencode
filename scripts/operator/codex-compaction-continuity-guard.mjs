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

function integer(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer: ${value}`)
  return parsed
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return value.map((item) => item.trim())
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const routingMetadata = JSON.stringify({
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
})

if (prohibited.test(routingMetadata)) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

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

let taskId
let criteriaHash
let checkpointId
let repositorySha
let diffHash
let completedStepsHash
let phase
let nextAction
let completedSteps
let remainingSteps
let compactionCount
let repeatedCommands
let repeatedBuilds
let reopenedResolved
let duplicateSubagentAssignments
let completedStepRegressions
let repetitionLimit
try {
  taskId = nonEmptyString(evidence.task_id, "task_id")
  criteriaHash = nonEmptyString(evidence.completion_criteria_sha256, "completion_criteria_sha256")
  checkpointId = nonEmptyString(evidence.checkpoint_id, "checkpoint_id")
  repositorySha = nonEmptyString(evidence.repository_sha, "repository_sha")
  diffHash = nonEmptyString(evidence.diff_sha256, "diff_sha256")
  completedStepsHash = nonEmptyString(evidence.completed_steps_sha256, "completed_steps_sha256")
  phase = nonEmptyString(evidence.phase, "phase")
  nextAction = nonEmptyString(evidence.next_action, "next_action")
  completedSteps = stringArray(evidence.completed_steps, "completed_steps")
  remainingSteps = stringArray(evidence.remaining_steps, "remaining_steps")
  compactionCount = integer(evidence.compaction_count)
  repeatedCommands = integer(evidence.repeated_command_count)
  repeatedBuilds = integer(evidence.repeated_build_without_diff_count)
  reopenedResolved = integer(evidence.reopened_resolved_count)
  duplicateSubagentAssignments = integer(evidence.duplicate_subagent_assignment_count)
  completedStepRegressions = integer(evidence.completed_step_regression_count)
  repetitionLimit = integer(args["repetition-limit"], 2)
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_checkpoint", detail: error.message }, null, 2))
  process.exit(2)
}

const checkpointRestored = evidence.checkpoint_restored === true
const repositoryStateVerified = evidence.repository_state_verified === true
const uncertainWritesReconciled = evidence.uncertain_writes_reconciled === true
const subagentsEnabled = evidence.subagents_enabled === true
const subagentResultsRestored = evidence.subagent_results_restored === true
const fixedBuildAttested = evidence.release_fix_attested === true
const freshTurn = evidence.fresh_guarded_turn === true
const continuationStatePersisted = evidence.continuation_state_persisted === true
const immutableCriteriaPreserved = evidence.restored_completion_criteria_sha256 === criteriaHash
const nextActionPreserved = evidence.restored_next_action === nextAction
const completedStepsPreserved = evidence.restored_completed_steps_sha256 === completedStepsHash

const repeatedWork =
  repeatedCommands > repetitionLimit ||
  repeatedBuilds > repetitionLimit ||
  reopenedResolved > repetitionLimit ||
  duplicateSubagentAssignments > repetitionLimit
const stateRegression = completedStepRegressions > 0
const restorationIncomplete =
  compactionCount > 0 &&
  (!checkpointRestored ||
    !repositoryStateVerified ||
    !immutableCriteriaPreserved ||
    !nextActionPreserved ||
    !completedStepsPreserved ||
    (subagentsEnabled && !subagentResultsRestored))

let admitted = true
let reason = "compaction_continuity_verified"

if (!uncertainWritesReconciled) {
  admitted = false
  reason = "uncertain_writes_not_reconciled"
} else if (stateRegression) {
  admitted = false
  reason = "completed_work_regressed_after_compaction"
} else if (repeatedWork) {
  admitted = false
  reason = "post_compaction_repetition_limit_reached"
} else if (restorationIncomplete && !(freshTurn && continuationStatePersisted)) {
  admitted = false
  reason = "compaction_checkpoint_restoration_incomplete"
} else if (compactionCount > 0 && subagentsEnabled && !fixedBuildAttested && !freshTurn) {
  admitted = false
  reason = "subagent_compaction_route_unattested"
}

const recovery =
  "Stop only the regressing turn. Persist the exact checkpoint, repository SHA, diff hash, completed and remaining steps, subagent findings, operation IDs, idempotency keys, and next action outside model memory. Reconcile uncertain writes, then continue in a fresh guarded single-agent turn on the pinned direct OpenAI route or the explicitly authorized local route. Do not repeat completed commands, builds, or subagent assignments."

const report = {
  admitted,
  reason,
  task_id: taskId,
  completion_criteria_sha256: criteriaHash,
  checkpoint_id: checkpointId,
  repository_sha: repositorySha,
  diff_sha256: diffHash,
  completed_steps_sha256: completedStepsHash,
  phase,
  next_action: nextAction,
  completed_steps: completedSteps.length,
  remaining_steps: remainingSteps.length,
  compaction_count: compactionCount,
  repeated_work_detected: repeatedWork,
  completed_step_regressions: completedStepRegressions,
  restoration_incomplete: restorationIncomplete,
  subagents_enabled: subagentsEnabled,
  protocol: admitted
    ? "Continue from the verified checkpoint. Preserve the external continuation ledger and do not authorize duplicate work or writes."
    : recovery,
  resume_condition:
    "Resume the affected turn only when the exact completion criteria, completed-step ledger, repository/diff state, subagent results, and next action are restored with zero repeated-work counters and all uncertain writes reconciled. Otherwise continue from a fresh guarded checkpointed turn.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(admitted ? 0 : 75)
