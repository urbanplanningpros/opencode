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
let goalId
let goal
let dependency
let criticalPath
let remainingWork
let routes
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  goalId = nonEmptyString(evidence.goal_id, "goal_id")
  goal = object(evidence.goal, "goal")
  dependency = object(evidence.dependency, "dependency")
  criticalPath = object(evidence.critical_path, "critical_path")
  remainingWork = array(evidence.remaining_work, "remaining_work")
  routes = array(evidence.routes, "routes")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const currentStatus = optionalString(goal.current_status, "goal.current_status").toLowerCase()
const requestedTransition = optionalString(goal.requested_transition, "goal.requested_transition").toLowerCase()
const userContinueRequested = boolean(goal.user_continue_requested, "goal.user_continue_requested")

const dependencyDescription = optionalString(dependency.description, "dependency.description")
const blockedAcceptanceCondition = optionalString(dependency.blocked_acceptance_condition, "dependency.blocked_acceptance_condition")
const requiredExternalChange = optionalString(dependency.required_external_change, "dependency.required_external_change")
const dependencyRecoverable = boolean(dependency.recoverable, "dependency.recoverable")
const branchScoped = boolean(dependency.branch_scoped, "dependency.branch_scoped")
const requiredNow = boolean(criticalPath.required_now, "critical_path.required_now")
const parentAcceptanceBlocked = boolean(criticalPath.parent_acceptance_blocked, "critical_path.parent_acceptance_blocked")

const executableBranches = []
for (let index = 0; index < remainingWork.length; index += 1) {
  const item = object(remainingWork[index], `remaining_work[${index}]`)
  const branchId = nonEmptyString(item.branch_id, `remaining_work[${index}].branch_id`)
  const executable = boolean(item.executable, `remaining_work[${index}].executable`)
  const independent = boolean(item.independent_of_dependency, `remaining_work[${index}].independent_of_dependency`)
  if (executable && independent) executableBranches.push(branchId)
}

const availableRoutes = []
const unexhaustedRoutes = []
for (let index = 0; index < routes.length; index += 1) {
  const route = object(routes[index], `routes[${index}]`)
  const type = nonEmptyString(route.type, `routes[${index}].type`).toLowerCase()
  const authorized = boolean(route.authorized, `routes[${index}].authorized`)
  const available = boolean(route.available, `routes[${index}].available`)
  const attempted = boolean(route.attempted, `routes[${index}].attempted`)
  const exhausted = boolean(route.exhausted, `routes[${index}].exhausted`)
  if (authorized && available) availableRoutes.push(type)
  if (authorized && available && (!attempted || !exhausted)) unexhaustedRoutes.push(type)
}

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const branchDeferredRecorded = boolean(state.branch_deferred_recorded, "state.branch_deferred_recorded")
const parentBlockJustificationRecorded = boolean(state.parent_block_justification_recorded, "state.parent_block_justification_recorded")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const replacementGoalRequested = boolean(state.replacement_goal_requested, "state.replacement_goal_requested")

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
  externalWritesReconciled

const ambiguousWriteState = !taskStatePreserved || !externalWritesReconciled
const blockRequested = requestedTransition === "blocked"
const falseGlobalBlock =
  blockRequested &&
  (dependencyRecoverable || branchScoped || executableBranches.length > 0 || unexhaustedRoutes.length > 0 || !requiredNow || !parentAcceptanceBlocked)

let admitted = true
let reason = "goal_continuity_verified"
let action = "continue_goal_normally"
let exitCode = 0

if ((automaticReplayRequested || replacementGoalRequested) && ambiguousWriteState) {
  admitted = false
  reason = "goal_replay_or_replacement_rejected_before_write_reconciliation"
  action = "preserve_original_goal_and_reconcile_durable_writes"
  exitCode = 64
} else if (blockRequested && executableBranches.length > 0) {
  admitted = false
  reason = "parent_block_rejected_with_executable_independent_work"
  action = "defer_only_the_blocked_branch_and_continue_parent_goal"
  exitCode = 75
} else if (blockRequested && unexhaustedRoutes.length > 0) {
  admitted = false
  reason = "parent_block_rejected_with_authorized_route_remaining"
  action = "attempt_the_verified_approved_route_and_preserve_operation_identity"
  exitCode = 75
} else if (blockRequested && (dependencyRecoverable || branchScoped || !requiredNow || !parentAcceptanceBlocked)) {
  admitted = false
  reason = "recoverable_or_branch_scoped_dependency_cannot_block_parent_goal"
  action = branchDeferredRecorded ? "continue_parent_goal" : "record_branch_deferred_dependency_then_continue_parent_goal"
  exitCode = 75
} else if (blockRequested && (dependencyDescription === "" || blockedAcceptanceCondition === "" || requiredExternalChange === "")) {
  admitted = false
  reason = "parent_block_missing_structured_critical_path_evidence"
  action = "record_dependency_acceptance_mapping_and_resume_condition"
  exitCode = 75
} else if (blockRequested && (!taskStatePreserved || !externalWritesReconciled || !parentBlockJustificationRecorded)) {
  admitted = false
  reason = "parent_block_requires_preserved_state_and_reconciled_writes"
  action = "checkpoint_goal_state_reconcile_writes_and_record_block_justification"
  exitCode = 75
} else if (userContinueRequested && currentStatus === "blocked" && executableBranches.length > 0 && routeReady) {
  reason = "blocked_goal_ui_bypassed_with_verified_continuity_route"
  action = "continue_exact_unfinished_work_without_replaying_completed_mutations"
} else if (userContinueRequested && currentStatus === "blocked" && executableBranches.length > 0 && !routeReady) {
  admitted = false
  reason = "blocked_goal_requires_verified_continuity_route"
  action = "reconcile_writes_and_verify_direct_openai_or_approved_local_route"
  exitCode = 75
} else if (falseGlobalBlock) {
  admitted = false
  reason = "parent_block_failed_critical_path_test"
  action = "scope_dependency_to_branch_and_continue_remaining_work"
  exitCode = 75
} else if (blockRequested) {
  reason = "parent_goal_block_supported_by_exhaustion_evidence"
  action = "pause_only_parent_goal_until_required_external_change_occurs"
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  goal_id: goalId,
  current_status: currentStatus,
  requested_transition: requestedTransition,
  executable_branches: executableBranches,
  available_routes: availableRoutes,
  unexhausted_routes: unexhaustedRoutes,
  resume_condition: requiredExternalChange,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
