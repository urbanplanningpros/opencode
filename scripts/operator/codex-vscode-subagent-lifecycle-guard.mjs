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

function optionalArray(value, name) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_app_server", "approved_local_openai"])
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
let taskId
let surface
let schema
let state
let continuity
let agents

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  taskId = nonEmptyString(evidence.task_id, "task_id")
  surface = optionalObject(evidence.surface, "surface")
  schema = optionalObject(evidence.tool_schema, "tool_schema")
  state = optionalObject(evidence.state, "state")
  continuity = optionalObject(evidence.continuity_route, "continuity_route")
  agents = optionalArray(evidence.agent_tree, "agent_tree")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const surfaceName = optionalString(surface.name, "surface.name").toLowerCase()
const multiAgentEnabled = boolean(surface.multi_agent_enabled, "surface.multi_agent_enabled")
const availableTools = new Set(optionalArray(schema.available_tools, "tool_schema.available_tools").map((tool) => String(tool)))
const closeAgentAvailable = availableTools.has("close_agent")
const verifiedEquivalent = optionalString(schema.verified_close_equivalent, "tool_schema.verified_close_equivalent")
const closeLifecycleAvailable = closeAgentAvailable || Boolean(verifiedEquivalent)
const interruptUsedAsClose = boolean(schema.interrupt_agent_used_as_close, "tool_schema.interrupt_agent_used_as_close")

const newAgentAdmissionRequested = boolean(state.new_agent_admission_requested, "state.new_agent_admission_requested")
const parentCompletionRequested = boolean(state.parent_completion_requested, "state.parent_completion_requested")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const replacementThreadRequested = boolean(state.replacement_thread_requested, "state.replacement_thread_requested")
const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const authoritativeTreeReadback = boolean(state.authoritative_agent_tree_readback, "state.authoritative_agent_tree_readback")

const normalizedAgents = agents.map((agent, index) => {
  const item = optionalObject(agent, `agent_tree[${index}]`)
  return {
    id: nonEmptyString(item.agent_id, `agent_tree[${index}].agent_id`),
    status: nonEmptyString(item.status, `agent_tree[${index}].status`).toLowerCase(),
    resultCollected: boolean(item.result_collected, `agent_tree[${index}].result_collected`),
    writesReconciled: boolean(item.writes_reconciled, `agent_tree[${index}].writes_reconciled`),
    closeReceipt: optionalString(item.close_receipt_id, `agent_tree[${index}].close_receipt_id`),
  }
})

const nonTerminalAgents = normalizedAgents.filter((agent) => !terminalStatuses.has(agent.status))
const terminalUnclosedAgents = normalizedAgents.filter(
  (agent) => terminalStatuses.has(agent.status) && agent.status !== "closed" && !agent.closeReceipt,
)
const unresolvedAgentResults = normalizedAgents.filter((agent) => !agent.resultCollected || !agent.writesReconciled)

const continuityType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const continuityVerified = boolean(continuity.verified, "continuity_route.verified")
const continuityCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const fallbackTools = new Set(optionalArray(continuity.available_tools, "continuity_route.available_tools").map((tool) => String(tool)))
const fallbackHasClose = fallbackTools.has("close_agent") || Boolean(optionalString(continuity.verified_close_equivalent, "continuity_route.verified_close_equivalent"))
const continuityReady =
  approvedRoutes.has(continuityType) &&
  continuityVerified &&
  continuityCanaryPassed &&
  operationBindingMatches &&
  fallbackHasClose &&
  taskStatePreserved &&
  externalWritesReconciled &&
  authoritativeTreeReadback &&
  !automaticReplayRequested &&
  !replacementThreadRequested

const affectedVsCodeLifecycle = surfaceName === "vscode" && multiAgentEnabled && !closeLifecycleAvailable

let admitted = true
let reason = "subagent_lifecycle_schema_verified"
let action = "continue_multi_agent_work"
let exitCode = 0

if (interruptUsedAsClose) {
  admitted = false
  reason = "interrupt_agent_is_not_lifecycle_closure"
  action = "wait_collect_reconcile_then_use_verified_close_route"
  exitCode = 64
} else if ((automaticReplayRequested || replacementThreadRequested) && unresolvedAgentResults.length > 0) {
  admitted = false
  reason = automaticReplayRequested
    ? "automatic_replay_rejected_with_unresolved_agent_state"
    : "replacement_thread_rejected_with_unresolved_agent_state"
  action = "preserve_existing_agent_tree_and_reconcile_exact_work"
  exitCode = 64
} else if (parentCompletionRequested && (nonTerminalAgents.length > 0 || unresolvedAgentResults.length > 0)) {
  admitted = false
  reason = "parent_completion_blocked_by_unresolved_child_agents"
  action = "wait_collect_results_and_reconcile_child_writes"
  exitCode = 75
} else if (affectedVsCodeLifecycle && newAgentAdmissionRequested && !continuityReady) {
  admitted = false
  reason = "vscode_close_agent_missing_new_admission_withheld"
  action = "continue_single_agent_or_prepare_verified_lifecycle_route"
  exitCode = 75
} else if (affectedVsCodeLifecycle && terminalUnclosedAgents.length > 0 && !continuityReady) {
  admitted = false
  reason = "completed_subagents_cannot_be_reclaimed_on_current_surface"
  action = "preserve_agent_tree_and_prepare_verified_close_route"
  exitCode = 75
} else if (affectedVsCodeLifecycle && continuityReady) {
  admitted = true
  reason = "vscode_lifecycle_gap_contained_with_verified_close_route"
  action = "finalize_existing_agents_then_continue_exact_unfinished_action"
} else if (affectedVsCodeLifecycle) {
  admitted = true
  reason = "vscode_lifecycle_gap_isolated_single_agent_continuation"
  action = "continue_without_new_subagent_admission"
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  task_id: taskId,
  close_agent_available: closeAgentAvailable,
  affected_vscode_lifecycle: affectedVsCodeLifecycle,
  non_terminal_agents: nonTerminalAgents.map((agent) => agent.id),
  terminal_unclosed_agents: terminalUnclosedAgents.map((agent) => agent.id),
  unresolved_agent_results: unresolvedAgentResults.map((agent) => agent.id),
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
