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

function integer(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function object(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${name} must be an array of non-empty strings`)
  return value.map((item) => item.trim())
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_cli", "direct_openai_api", "direct_openai_app_server", "approved_local_openai", "approved_local_windows", "approved_local_linux"])

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
let remote
let creation
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  remote = object(evidence.remote, "remote")
  creation = object(evidence.creation, "creation")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const client = nonEmptyString(remote.client, "remote.client")
const connectionId = nonEmptyString(remote.connection_id, "remote.connection_id")
const resumeCount = integer(remote.resume_count, "remote.resume_count")
const startCount = integer(remote.thread_start_count, "remote.thread_start_count")

const callId = nonEmptyString(creation.call_id, "creation.call_id")
const requestedCount = integer(creation.requested_count, "creation.requested_count")
const persistedThreadIds = stringArray(creation.persisted_thread_ids, "creation.persisted_thread_ids")
const idempotencyKey = optionalString(creation.idempotency_key, "creation.idempotency_key")
const originalThreadId = optionalString(creation.original_thread_id, "creation.original_thread_id")
const dedupeReceiptVerified = boolean(creation.dedupe_receipt_verified, "creation.dedupe_receipt_verified")
const callBindingMatches = boolean(creation.call_binding_matches, "creation.call_binding_matches")
const automaticReplayRequested = boolean(creation.automatic_replay_requested, "creation.automatic_replay_requested")
const replacementThreadRequested = boolean(creation.replacement_thread_requested, "creation.replacement_thread_requested")
const duplicateThreadsQuarantined = boolean(creation.duplicate_threads_quarantined, "creation.duplicate_threads_quarantined")
const canonicalThreadPreserved = boolean(creation.canonical_thread_preserved, "creation.canonical_thread_preserved")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const threadInventoryReconciled = boolean(state.thread_inventory_reconciled, "state.thread_inventory_reconciled")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const canaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && canaryPassed && operationBindingMatches && taskStatePreserved && externalWritesReconciled

const uniqueThreadIds = [...new Set(persistedThreadIds)]
const duplicateCreationDetected = startCount > requestedCount || uniqueThreadIds.length > requestedCount
const idempotencyBound = idempotencyKey !== "" && callBindingMatches
const canonicalIdentityProven = originalThreadId !== "" && uniqueThreadIds.includes(originalThreadId)

let admitted = true
let reason = "remote_thread_creation_idempotency_verified"
let action = "continue_remote_thread_operation"
let exitCode = 0

if (requestedCount !== 1) {
  admitted = false
  reason = "remote_create_thread_requires_single_logical_operation"
  action = "split_each_thread_creation_into_a_separate_operation_id"
  exitCode = 64
} else if ((automaticReplayRequested || replacementThreadRequested) && (!taskStatePreserved || !externalWritesReconciled || !threadInventoryReconciled)) {
  admitted = false
  reason = "thread_replay_or_replacement_rejected_before_reconciliation"
  action = "preserve_original_call_and_reconcile_thread_and_write_state"
  exitCode = 64
} else if (duplicateCreationDetected && (!canonicalIdentityProven || !canonicalThreadPreserved || !duplicateThreadsQuarantined || !threadInventoryReconciled)) {
  admitted = false
  reason = "duplicate_remote_threads_require_canonical_reconciliation"
  action = "preserve_first_bound_thread_quarantine_duplicates_and_reconcile_all_writes"
  exitCode = 75
} else if (duplicateCreationDetected) {
  admitted = false
  reason = "remote_create_thread_replay_detected"
  action = routeReady
    ? "continue_only_the_canonical_thread_via_verified_route"
    : "establish_verified_route_before_continuing_canonical_thread"
  exitCode = 75
} else if (!idempotencyBound || !dedupeReceiptVerified) {
  admitted = false
  reason = "side_effecting_thread_creation_lacks_idempotency_binding"
  action = "bind_operation_id_call_id_and_idempotency_key_then_verify_deduplication"
  exitCode = 75
} else if (startCount !== 1 || uniqueThreadIds.length !== 1 || !canonicalIdentityProven) {
  admitted = false
  reason = "thread_start_and_persistence_receipts_do_not_prove_exactly_once_creation"
  action = "reconcile_app_server_requests_and_persisted_thread_inventory"
  exitCode = 75
} else if (resumeCount > 1 && !dedupeReceiptVerified) {
  admitted = false
  reason = "repeated_remote_resume_requires_side_effect_deduplication"
  action = "return_original_thread_identity_without_redispatching_create_thread"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  client,
  connection_id: connectionId,
  call_id: callId,
  resume_count: resumeCount,
  thread_start_count: startCount,
  persisted_thread_ids: uniqueThreadIds,
  canonical_thread_id: originalThreadId,
  idempotency_bound: idempotencyBound,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
