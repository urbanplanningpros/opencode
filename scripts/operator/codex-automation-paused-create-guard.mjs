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

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_api", "direct_openai_app_server", "approved_local_openai", "approved_local_automation_editor"])

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
let automation
let correction
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  automation = object(evidence.automation, "automation")
  correction = object(evidence.correction, "correction")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const automationId = nonEmptyString(automation.id, "automation.id")
const mode = nonEmptyString(automation.mode, "automation.mode").toLowerCase()
const requestedStatus = nonEmptyString(automation.requested_status, "automation.requested_status").toUpperCase()
const persistedStatus = optionalString(automation.persisted_status, "automation.persisted_status").toUpperCase()
const postCreateReadback = boolean(automation.post_create_readback, "automation.post_create_readback")
const storedPayloadHash = optionalString(automation.stored_payload_hash, "automation.stored_payload_hash")
const requestedPayloadHash = optionalString(automation.requested_payload_hash, "automation.requested_payload_hash")
const nextTriggerKnown = boolean(automation.next_trigger_known, "automation.next_trigger_known")
const nextTriggerImminent = boolean(automation.next_trigger_imminent, "automation.next_trigger_imminent")

const correctionAttempted = boolean(correction.attempted, "correction.attempted")
const fullReadModifyWriteUsed = boolean(correction.full_read_modify_write_used, "correction.full_read_modify_write_used")
const nonStatusFieldsPreserved = boolean(correction.non_status_fields_preserved, "correction.non_status_fields_preserved")
const correctedStatusReadback = optionalString(correction.corrected_status_readback, "correction.corrected_status_readback").toUpperCase()
const schedulerSuppressedUntilVerified = boolean(correction.scheduler_suppressed_until_verified, "correction.scheduler_suppressed_until_verified")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const automaticEnableAccepted = boolean(state.automatic_enable_accepted, "state.automatic_enable_accepted")
const blindRetryRequested = boolean(state.blind_retry_requested, "state.blind_retry_requested")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const canaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && canaryPassed && operationBindingMatches && taskStatePreserved && externalWritesReconciled

const statusMismatch = requestedStatus !== persistedStatus
const pausedCreateMismatch = mode === "create" && requestedStatus === "PAUSED" && persistedStatus === "ACTIVE"
const payloadMatches = requestedPayloadHash !== "" && storedPayloadHash !== "" && requestedPayloadHash === storedPayloadHash
const correctionVerified = correctionAttempted && fullReadModifyWriteUsed && nonStatusFieldsPreserved && correctedStatusReadback === "PAUSED"

let admitted = true
let reason = "automation_create_status_verified"
let action = "continue_automation_workflow"
let exitCode = 0

if (!postCreateReadback) {
  admitted = false
  reason = "automation_create_requires_persisted_status_readback"
  action = "read_saved_automation_state_before_accepting_create_success"
  exitCode = 75
} else if (pausedCreateMismatch && !correctionVerified) {
  admitted = false
  reason = "paused_automation_was_persisted_active"
  action = nextTriggerImminent
    ? "suppress_only_this_automation_then_apply_full_update_to_paused_and_verify"
    : "apply_full_read_modify_write_update_to_paused_and_verify"
  exitCode = 75
} else if (pausedCreateMismatch && correctionVerified && !schedulerSuppressedUntilVerified) {
  admitted = false
  reason = "automation_status_corrected_without_scheduler_suppression_receipt"
  action = "verify_no_trigger_ran_before_paused_status_readback"
  exitCode = 75
} else if (statusMismatch) {
  admitted = false
  reason = "automation_persisted_state_differs_from_requested_state"
  action = "reconcile_complete_saved_payload_and_apply_verified_update"
  exitCode = 75
} else if (!payloadMatches) {
  admitted = false
  reason = "automation_payload_readback_hash_mismatch"
  action = "perform_full_read_modify_write_without_reconstructing_missing_fields"
  exitCode = 75
} else if ((automaticEnableAccepted || blindRetryRequested) && (!taskStatePreserved || !externalWritesReconciled)) {
  admitted = false
  reason = "automation_retry_or_enable_rejected_before_reconciliation"
  action = "preserve_operation_state_and_reconcile_prior_runs_and_writes"
  exitCode = 64
} else if (nextTriggerKnown && nextTriggerImminent && requestedStatus === "PAUSED" && !schedulerSuppressedUntilVerified) {
  admitted = false
  reason = "imminent_trigger_requires_specific_automation_suppression"
  action = routeReady
    ? "suppress_only_this_automation_and_continue_other_workflows"
    : "suppress_only_this_automation_then_verify_an_approved_edit_route"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  automation_id: automationId,
  requested_status: requestedStatus,
  persisted_status: persistedStatus,
  paused_create_mismatch: pausedCreateMismatch,
  correction_verified: correctionVerified,
  payload_matches: payloadMatches,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
