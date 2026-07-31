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

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return value.map((entry) => entry.trim().toLowerCase())
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|model[-_ ]?gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set([
  "direct_openai_app_server",
  "direct_openai_api",
  "approved_openai_connector_runtime",
  "approved_local_openai",
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
let turn
let connectors
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  turn = object(evidence.turn, "turn")
  connectors = object(evidence.connectors, "connectors")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const threadSource = nonEmptyString(turn.thread_source, "turn.thread_source").toLowerCase()
const isFollowup = boolean(turn.is_followup, "turn.is_followup")
const appsInstructionsBefore = boolean(turn.apps_instructions_before, "turn.apps_instructions_before")
const appsInstructionsAfter = boolean(turn.apps_instructions_after, "turn.apps_instructions_after")
const explicitAppsDisable = boolean(turn.explicit_apps_disable, "turn.explicit_apps_disable")
const canonicalThreadPreserved = boolean(turn.canonical_thread_preserved, "turn.canonical_thread_preserved")

const authStillValid = boolean(connectors.auth_still_valid, "connectors.auth_still_valid")
const requiredFamilies = stringArray(connectors.required_families, "connectors.required_families")
const registeredFamilies = new Set(stringArray(connectors.registered_families, "connectors.registered_families"))
const readOnlyCanaryPassed = boolean(connectors.read_only_canary_passed, "connectors.read_only_canary_passed")
const catalogRevisionReadback = boolean(connectors.catalog_revision_readback, "connectors.catalog_revision_readback")
const oauthReconnectRequested = boolean(connectors.oauth_reconnect_requested, "connectors.oauth_reconnect_requested")
const permissionBroadeningRequested = boolean(connectors.permission_broadening_requested, "connectors.permission_broadening_requested")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const priorTurnPreserved = boolean(state.prior_turn_preserved, "state.prior_turn_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const staleAnswerAccepted = boolean(state.stale_answer_accepted, "state.stale_answer_accepted")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const unrelatedWorkContinues = boolean(state.unrelated_work_continues, "state.unrelated_work_continues")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const routeCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && routeCanaryPassed && operationBindingMatches

const automationFollowup = threadSource === "automation" && isFollowup
const silentAppsDisable = automationFollowup && appsInstructionsBefore && !appsInstructionsAfter && !explicitAppsDisable
const missingFamilies = requiredFamilies.filter((family) => !registeredFamilies.has(family))
const connectorCatalogReady = appsInstructionsAfter && missingFamilies.length === 0 && readOnlyCanaryPassed && catalogRevisionReadback
const preservationReady = canonicalThreadPreserved && taskStatePreserved && priorTurnPreserved && externalWritesReconciled

let admitted = true
let reason = "automation_connector_catalog_verified"
let action = "continue_connector_backed_followup"
let exitCode = 0

if (silentAppsDisable) {
  admitted = false
  reason = "automation_followup_silently_disabled_apps"
  action = routeReady && preservationReady
    ? "rehydrate_connector_catalog_on_canonical_thread_or_continue_exact_followup_through_verified_route"
    : "preserve_thread_and_rehydrate_connector_catalog_before_answering"
  exitCode = 75
} else if (automationFollowup && missingFamilies.length > 0) {
  admitted = false
  reason = "required_connector_families_missing_after_followup"
  action = routeReady && preservationReady
    ? "continue_only_connector_dependent_step_through_verified_operation_bound_route"
    : "fail_closed_for_connector_dependent_claims_and_rehydrate_missing_tools"
  exitCode = 75
} else if (automationFollowup && !readOnlyCanaryPassed) {
  admitted = false
  reason = "connector_read_only_canary_required_after_followup"
  action = "run_profile_or_metadata_canary_before_connector_dependent_work"
  exitCode = 75
} else if (automationFollowup && !catalogRevisionReadback) {
  admitted = false
  reason = "connector_catalog_revision_not_verified"
  action = "read_back_effective_tool_catalog_and_bind_revision_to_operation"
  exitCode = 75
} else if (staleAnswerAccepted && !connectorCatalogReady) {
  admitted = false
  reason = "stale_or_incomplete_answer_rejected_without_live_connectors"
  action = "withhold_connector_dependent_answer_and_continue_unrelated_work"
  exitCode = 64
} else if ((oauthReconnectRequested || permissionBroadeningRequested) && authStillValid && !connectorCatalogReady) {
  admitted = false
  reason = "connector_hydration_failure_must_not_trigger_auth_or_permission_mutation"
  action = "preserve_existing_authorization_and_restore_tool_registration"
  exitCode = 64
} else if (automaticReplayRequested && !preservationReady) {
  admitted = false
  reason = "automation_replay_rejected_before_state_and_write_reconciliation"
  action = "reconcile_prior_turn_and_external_writes_then_continue_exact_unfinished_step"
  exitCode = 64
} else if (!unrelatedWorkContinues && !connectorCatalogReady) {
  admitted = false
  reason = "unrelated_automation_work_should_not_be_globally_paused"
  action = "isolate_only_connector_dependent_step_and_continue_safe_independent_work"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  automation_followup: automationFollowup,
  silent_apps_disable: silentAppsDisable,
  missing_connector_families: missingFamilies,
  connector_catalog_ready: connectorCatalogReady,
  state_preserved: preservationReady,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
