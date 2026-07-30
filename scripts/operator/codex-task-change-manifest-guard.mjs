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

function normalizeFile(item, name) {
  const entry = object(item, name)
  const repository = nonEmptyString(entry.repository, `${name}.repository`)
  const filePath = nonEmptyString(entry.path, `${name}.path`).replaceAll("\\", "/")
  if (filePath.startsWith("/") || filePath.includes("../") || filePath === "..") {
    throw new Error(`${name}.path must be repository-relative`)
  }
  return `${repository}::${filePath}`
}

function fileSet(value, name) {
  return new Set(array(value, name).map((item, index) => normalizeFile(item, `${name}[${index}]`)))
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_api", "direct_openai_app_server", "approved_local_openai"])
const terminalStatuses = new Set(["completed", "failed", "cancelled", "closed"])

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
let parentTaskId
let repositories
let agentTree
let uiReview
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  parentTaskId = nonEmptyString(evidence.parent_task_id, "parent_task_id")
  repositories = array(evidence.repositories, "repositories")
  agentTree = array(evidence.agent_tree, "agent_tree")
  uiReview = object(evidence.ui_review, "ui_review")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const authoritative = new Set()
const repositoryNames = new Set()

try {
  for (let index = 0; index < repositories.length; index += 1) {
    const repo = object(repositories[index], `repositories[${index}]`)
    const name = nonEmptyString(repo.name, `repositories[${index}].name`)
    if (repositoryNames.has(name)) throw new Error(`duplicate repository name: ${name}`)
    repositoryNames.add(name)
    const gitFiles = fileSet(repo.git_changed_files ?? [], `repositories[${index}].git_changed_files`)
    for (const file of gitFiles) authoritative.add(file)
  }

  for (let index = 0; index < agentTree.length; index += 1) {
    const agent = object(agentTree[index], `agent_tree[${index}]`)
    const changed = fileSet(agent.changed_files ?? [], `agent_tree[${index}].changed_files`)
    for (const file of changed) authoritative.add(file)
  }
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_change_manifest", detail: error.message }, null, 2))
  process.exit(2)
}

const uiFiles = fileSet(uiReview.parent_edited_files ?? [], "ui_review.parent_edited_files")
const uiAuthoritative = boolean(uiReview.authoritative, "ui_review.authoritative")
const undoScopeVerified = boolean(uiReview.undo_scope_verified, "ui_review.undo_scope_verified")
const multiRepoReview = boolean(uiReview.multi_repository_review, "ui_review.multi_repository_review")

const parentCompletionRequested = boolean(state.parent_completion_requested, "state.parent_completion_requested")
const automaticUndoRequested = boolean(state.automatic_undo_requested, "state.automatic_undo_requested")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const gitCheckpointCreated = boolean(state.git_checkpoint_created, "state.git_checkpoint_created")
const authoritativeManifestRecorded = boolean(state.authoritative_manifest_recorded, "state.authoritative_manifest_recorded")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const routeCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")

const unresolvedAgents = []
for (let index = 0; index < agentTree.length; index += 1) {
  const agent = object(agentTree[index], `agent_tree[${index}]`)
  const agentId = nonEmptyString(agent.agent_id, `agent_tree[${index}].agent_id`)
  const status = optionalString(agent.status, `agent_tree[${index}].status`).toLowerCase()
  const resultCollected = boolean(agent.result_collected, `agent_tree[${index}].result_collected`)
  const writesReconciled = boolean(agent.writes_reconciled, `agent_tree[${index}].writes_reconciled`)
  if (!terminalStatuses.has(status) || !resultCollected || !writesReconciled) unresolvedAgents.push(agentId)
}

const missingFromUi = [...authoritative].filter((file) => !uiFiles.has(file)).sort()
const extraInUi = [...uiFiles].filter((file) => !authoritative.has(file)).sort()
const uiIncomplete = missingFromUi.length > 0
const uiDiverged = uiIncomplete || extraInUi.length > 0
const routeReady =
  approvedRoutes.has(routeType) &&
  routeVerified &&
  routeCanaryPassed &&
  operationBindingMatches &&
  taskStatePreserved &&
  externalWritesReconciled

let admitted = true
let reason = "task_change_manifest_verified"
let action = "continue_with_authoritative_git_manifest"
let exitCode = 0

if (automaticReplayRequested && (uiDiverged || unresolvedAgents.length > 0)) {
  admitted = false
  reason = "automatic_replay_rejected_with_unresolved_change_state"
  action = "preserve_task_and_reconcile_exact_unfinished_action"
  exitCode = 64
} else if (parentCompletionRequested && unresolvedAgents.length > 0) {
  admitted = false
  reason = "parent_completion_blocked_by_unresolved_subagent_changes"
  action = "collect_results_and_reconcile_child_writes"
  exitCode = 75
} else if (automaticUndoRequested && (!undoScopeVerified || uiDiverged)) {
  admitted = false
  reason = "automatic_undo_rejected_for_incomplete_task_change_manifest"
  action = "restore_from_git_checkpoint_or_apply_verified_full_manifest"
  exitCode = 64
} else if (uiAuthoritative && uiDiverged) {
  admitted = false
  reason = "parent_review_surface_is_not_authoritative"
  action = "use_git_diff_and_agent_tree_union_as_authority"
  exitCode = 75
} else if (uiIncomplete && (!authoritativeManifestRecorded || !gitCheckpointCreated)) {
  admitted = false
  reason = "subagent_changes_missing_from_parent_review"
  action = "record_full_manifest_and_create_git_checkpoint"
  exitCode = 75
} else if (uiIncomplete && !routeReady) {
  admitted = false
  reason = "incomplete_ui_review_requires_verified_continuity_route"
  action = "verify_direct_openai_or_approved_local_continuation"
  exitCode = 75
} else if (uiIncomplete && routeReady) {
  reason = "incomplete_parent_review_contained_by_authoritative_manifest"
  action = "continue_without_trusting_ui_review_or_undo"
} else if (!multiRepoReview && repositoryNames.size > 1) {
  admitted = false
  reason = "multi_repository_task_requires_cross_repository_manifest"
  action = "enable_or_export_multi_repository_review_and_git_manifest"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  parent_task_id: parentTaskId,
  authoritative_file_count: authoritative.size,
  ui_file_count: uiFiles.size,
  missing_from_ui: missingFromUi,
  extra_in_ui: extraInUi,
  unresolved_agents: unresolvedAgents,
  repositories: [...repositoryNames].sort(),
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
