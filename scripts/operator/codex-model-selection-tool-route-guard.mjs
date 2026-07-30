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

function stringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`)
  return value.map((item, index) => nonEmptyString(item, `${name}[${index}]`))
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_api", "direct_openai_app_server", "approved_local_openai"])
const hiddenValues = new Set(["hide", "hidden", "internal"])
const brokenModel = "codex-auto-review"
const execNormalizationError = /unsupported custom tool call:\s*execexec/i

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
let selectedModel
let selection
let catalog
let toolProbe
let state
let continuity
let allowedModels

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  selectedModel = nonEmptyString(evidence.selected_model_slug, "selected_model_slug").toLowerCase()
  selection = optionalObject(evidence.selection, "selection")
  catalog = optionalObject(evidence.catalog_entry, "catalog_entry")
  toolProbe = optionalObject(evidence.tool_probe, "tool_probe")
  state = optionalObject(evidence.state, "state")
  continuity = optionalObject(evidence.continuity_route, "continuity_route")
  allowedModels = stringArray(evidence.allowed_model_slugs, "allowed_model_slugs").map((value) => value.toLowerCase())
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (allowedModels.some((model) => prohibited.test(model))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_model_in_allowlist" }, null, 2))
  process.exit(64)
}

const source = optionalString(selection.source, "selection.source").toLowerCase()
const exactSlugVerified = boolean(selection.exact_slug_verified, "selection.exact_slug_verified")
const displayDuplicateCount = Number(selection.display_label_duplicate_count ?? 1)
const visibility = optionalString(catalog.visibility, "catalog_entry.visibility").toLowerCase()
const userSelectable = boolean(catalog.user_selectable, "catalog_entry.user_selectable", true)
const toolMode = optionalString(catalog.tool_mode, "catalog_entry.tool_mode")
const executionRequested = boolean(toolProbe.execution_requested, "tool_probe.execution_requested")
const observedError = optionalString(toolProbe.observed_error, "tool_probe.observed_error")
const failedCalls = Number(toolProbe.failed_calls ?? 0)
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")

const continuityType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const continuityVerified = boolean(continuity.verified, "continuity_route.verified")
const continuityCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const pinnedModel = optionalString(continuity.pinned_model_slug, "continuity_route.pinned_model_slug").toLowerCase()
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")

const selectedAllowed = allowedModels.includes(selectedModel)
const selectedHidden = hiddenValues.has(visibility) || !userSelectable
const pickerAmbiguous = source === "picker" && displayDuplicateCount > 1 && !exactSlugVerified
const brokenExecutionSelection = selectedModel === brokenModel && executionRequested
const executionMetadataMissing = executionRequested && !toolMode
const normalizationFailureObserved = execNormalizationError.test(observedError) || (selectedModel === brokenModel && failedCalls > 0)
const continuityReady =
  approvedRoutes.has(continuityType) &&
  continuityVerified &&
  continuityCanaryPassed &&
  operationBindingMatches &&
  allowedModels.includes(pinnedModel) &&
  pinnedModel !== brokenModel &&
  externalWritesReconciled &&
  taskStatePreserved &&
  !automaticReplayRequested

let admitted = true
let reason = "model_selection_and_tool_route_verified"
let exitCode = 0
let action = "continue_selected_model"

if (!selectedAllowed) {
  admitted = false
  reason = "selected_model_not_explicitly_allowed"
  exitCode = 64
  action = "pin_an_explicit_approved_openai_model"
} else if (selectedHidden && source === "picker") {
  admitted = false
  reason = "hidden_model_must_not_be_user_selectable"
  exitCode = 64
  action = "remove_hidden_picker_entry_and_pin_exact_slug"
} else if (pickerAmbiguous) {
  admitted = false
  reason = "ambiguous_duplicate_model_label"
  exitCode = 64
  action = "verify_and_pin_exact_model_slug"
} else if (brokenExecutionSelection) {
  admitted = false
  reason = "auto_review_model_not_authorized_for_tool_execution"
  exitCode = 75
  action = continuityReady ? "continue_via_verified_pinned_model" : "prepare_verified_pinned_model_continuity"
} else if (executionMetadataMissing) {
  admitted = false
  reason = "execution_model_tool_mode_missing"
  exitCode = 75
  action = continuityReady ? "continue_via_verified_pinned_model" : "prepare_verified_pinned_model_continuity"
} else if (normalizationFailureObserved && !continuityReady) {
  admitted = false
  reason = automaticReplayRequested
    ? "automatic_replay_rejected_after_tool_route_failure"
    : "tool_route_failure_requires_reconciled_pinned_continuity"
  exitCode = automaticReplayRequested ? 64 : 75
  action = "preserve_state_reconcile_writes_and_reroute_exact_unfinished_action"
} else if (normalizationFailureObserved && continuityReady) {
  admitted = true
  reason = "tool_route_failure_contained_with_verified_pinned_continuity"
  action = "continue_exact_unfinished_action_via_pinned_model"
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  selected_model_slug: selectedModel,
  pinned_model_slug: pinnedModel || null,
  execution_requested: executionRequested,
  normalization_failure_observed: normalizationFailureObserved,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
