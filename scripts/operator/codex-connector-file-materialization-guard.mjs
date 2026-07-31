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
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|model[-_ ]?gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set([
  "direct_openai_connector_materializer",
  "approved_provider_export_to_workspace",
  "approved_local_sync_ingress",
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
let source
let transfer
let retry
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  source = object(evidence.source, "source")
  transfer = object(evidence.transfer, "transfer")
  retry = object(evidence.retry, "retry")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const referenceType = nonEmptyString(source.reference_type, "source.reference_type").toLowerCase()
const referencePresent = boolean(source.reference_present, "source.reference_present")
const opaqueReference = boolean(source.opaque_reference, "source.opaque_reference")
const sourceAuthorized = boolean(source.authorized, "source.authorized")
const tenantBindingVerified = boolean(source.tenant_binding_verified, "source.tenant_binding_verified")
const credentialsExposed = boolean(source.credentials_exposed, "source.credentials_exposed")
const signedUrlExposed = boolean(source.signed_url_exposed, "source.signed_url_exposed")
const inlineBase64Used = boolean(source.inline_base64_used, "source.inline_base64_used")
const guessedUriConversion = boolean(source.guessed_uri_conversion, "source.guessed_uri_conversion")
const arbitraryProviderUrlUsed = boolean(source.arbitrary_provider_url_used, "source.arbitrary_provider_url_used")
const sourceModified = boolean(source.source_modified, "source.source_modified")

const consumerContractAvailable = boolean(transfer.consumer_contract_available, "transfer.consumer_contract_available")
const destinationRoot = optionalString(transfer.destination_root, "transfer.destination_root")
const destinationPath = optionalString(transfer.destination_path, "transfer.destination_path")
const insideWorkspace = boolean(transfer.inside_workspace_after_symlink_resolution, "transfer.inside_workspace_after_symlink_resolution")
const privateTempUsed = boolean(transfer.private_temp_used, "transfer.private_temp_used")
const atomicRename = boolean(transfer.atomic_rename, "transfer.atomic_rename")
const overwriteRequested = boolean(transfer.overwrite_requested, "transfer.overwrite_requested")
const sizeReadback = boolean(transfer.size_bytes_readback, "transfer.size_bytes_readback")
const shaReadback = boolean(transfer.sha256_readback, "transfer.sha256_readback")
const integrityVerified = boolean(transfer.integrity_verified, "transfer.integrity_verified")
const cancellationBounded = boolean(transfer.cancellation_bounded, "transfer.cancellation_bounded")
const orphanCleanupVerified = boolean(transfer.orphan_cleanup_verified, "transfer.orphan_cleanup_verified")
const localPathReadable = boolean(transfer.local_path_readable, "transfer.local_path_readable")

const idempotencyKeyPresent = boolean(retry.idempotency_key_present, "retry.idempotency_key_present")
const sameArgsReuse = boolean(retry.same_key_same_args_reuses_artifact, "retry.same_key_same_args_reuses_artifact")
const differentArgsConflict = boolean(retry.same_key_different_args_conflicts, "retry.same_key_different_args_conflicts")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const localParserStarted = boolean(state.local_parser_started, "state.local_parser_started")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const unrelatedWorkContinues = boolean(state.unrelated_work_continues, "state.unrelated_work_continues")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const routeCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && routeCanaryPassed && operationBindingMatches

const unsafeTransport = credentialsExposed || signedUrlExposed || inlineBase64Used || guessedUriConversion || arbitraryProviderUrlUsed || sourceModified
const sourceReady = referencePresent && sourceAuthorized && tenantBindingVerified
const destinationBound = destinationRoot !== "" && destinationPath !== "" && insideWorkspace && !overwriteRequested
const retrySafe = idempotencyKeyPresent && sameArgsReuse && differentArgsConflict
const transferComplete = consumerContractAvailable && sourceReady && destinationBound && privateTempUsed && atomicRename && sizeReadback && shaReadback && integrityVerified && cancellationBounded && orphanCleanupVerified && localPathReadable && retrySafe
const preservationReady = taskStatePreserved && externalWritesReconciled
const opaqueConnectorReference = opaqueReference || referenceType === "file_uri"

let admitted = true
let reason = "connector_file_materialization_verified"
let action = "continue_local_file_processing"
let exitCode = 0

if (unsafeTransport) {
  admitted = false
  reason = "unsafe_connector_file_transport_rejected"
  action = "preserve_opaque_reference_and_use_a_structured_authorized_consumer"
  exitCode = 64
} else if (!sourceReady) {
  admitted = false
  reason = "connector_reference_authorization_or_tenant_binding_missing"
  action = "verify_exact_reference_authority_without_exposing_credentials_or_urls"
  exitCode = 64
} else if (opaqueConnectorReference && !consumerContractAvailable) {
  admitted = false
  reason = "opaque_connector_reference_has_no_workspace_materializer"
  action = routeReady && preservationReady
    ? "export_through_verified_provider_or_sync_ingress_then_hash_and_atomically_stage"
    : "withhold_local_parsing_until_an_approved_materialization_route_is_verified"
  exitCode = 75
} else if (!destinationBound) {
  admitted = false
  reason = "materialization_destination_not_safely_bound"
  action = "normalize_after_symlink_resolution_and_refuse_overwrite_outside_workspace"
  exitCode = 64
} else if (!retrySafe) {
  admitted = false
  reason = "materialization_retry_semantics_not_idempotent"
  action = "bind_caller_owned_key_and_enforce_same_args_reuse_and_different_args_conflict"
  exitCode = 75
} else if (!transferComplete) {
  admitted = false
  reason = "materialized_file_integrity_or_cleanup_receipt_incomplete"
  action = "stream_to_private_temp_verify_size_and_sha_then_atomically_rename"
  exitCode = 75
} else if (localParserStarted && !transferComplete) {
  admitted = false
  reason = "local_parser_started_before_materialization_verification"
  action = "stop_only_the_parser_and_preserve_the_source_reference"
  exitCode = 64
} else if (automaticReplayRequested && !preservationReady) {
  admitted = false
  reason = "materialization_replay_rejected_before_reconciliation"
  action = "reconcile_prior_artifacts_and_external_writes_before_retry"
  exitCode = 64
} else if (!unrelatedWorkContinues && !transferComplete) {
  admitted = false
  reason = "missing_materializer_must_not_pause_independent_work"
  action = "isolate_only_file_dependent_step_and_continue_safe_work"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  opaque_connector_reference: opaqueConnectorReference,
  source_ready: sourceReady,
  destination_bound: destinationBound,
  retry_safe: retrySafe,
  transfer_complete: transferComplete,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
