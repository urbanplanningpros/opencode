import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      i += 1
    } else parsed[key] = true
  }
  return parsed
}

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular non-symlink file`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}
function string(value, name, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return ""
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}
function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}
function integer(value, name, fallback = 0) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_local_artifact_pipeline",
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

let operationId, attachment, state, continuity
try {
  operationId = string(evidence.operation_id, "operation_id")
  attachment = object(evidence.attachment, "attachment")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const filename = string(attachment.filename, "attachment.filename")
const contentSha = string(attachment.content_sha256, "attachment.content_sha256").toLowerCase()
const uploadedSha = string(attachment.uploaded_sha256, "attachment.uploaded_sha256").toLowerCase()
const byteCount = integer(attachment.byte_count, "attachment.byte_count")
const sameFilenameReused = bool(attachment.same_filename_reused, "attachment.same_filename_reused")
const cacheIdentityType = string(attachment.cache_identity_type, "attachment.cache_identity_type").toLowerCase()
const freshTask = bool(attachment.fresh_task, "attachment.fresh_task")
const currentRevisionConfirmed = bool(attachment.current_revision_confirmed, "attachment.current_revision_confirmed")
const visualCanaryPassed = bool(attachment.visual_canary_passed, "attachment.visual_canary_passed")
const previewMatchesInput = bool(attachment.preview_matches_input, "attachment.preview_matches_input")

const taskStatePreserved = bool(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = bool(state.external_writes_reconciled, "state.external_writes_reconciled")
const priorDerivedOutputsInvalidated = bool(state.prior_derived_outputs_invalidated, "state.prior_derived_outputs_invalidated")
const replayRequested = bool(state.replay_requested, "state.replay_requested")
const replacementTaskRequested = bool(state.replacement_task_requested, "state.replacement_task_requested")

const routeType = string(continuity.type, "continuity_route.type", true).toLowerCase()
const routeVerified = bool(continuity.verified, "continuity_route.verified")
const canaryPassed = bool(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = bool(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const artifactHashBindingMatches = bool(continuity.artifact_hash_binding_matches, "continuity_route.artifact_hash_binding_matches")

const shaPattern = /^[a-f0-9]{64}$/
const hashesValid = shaPattern.test(contentSha) && shaPattern.test(uploadedSha)
const byteIdentityVerified = hashesValid && contentSha === uploadedSha && byteCount > 0
const cacheIdentitySafe = cacheIdentityType === "content_hash" || cacheIdentityType === "opaque_upload_id"
const routeReady = approvedRoutes.has(routeType) && routeVerified && canaryPassed && operationBindingMatches && artifactHashBindingMatches
const revisionBoundaryVerified = byteIdentityVerified && cacheIdentitySafe && freshTask && currentRevisionConfirmed && visualCanaryPassed && previewMatchesInput

let admitted = true
let reason = "image_input_revision_verified"
let action = "continue_visual_analysis_with_hash_bound_attachment"
let exitCode = 0

if ((replayRequested || replacementTaskRequested) && (!taskStatePreserved || !externalWritesReconciled)) {
  admitted = false
  reason = "replay_or_replacement_rejected_before_write_reconciliation"
  action = "preserve_the_canonical_task_and_reconcile_prior_visual_or_external_outputs"
  exitCode = 64
} else if (!hashesValid || byteCount === 0) {
  admitted = false
  reason = "attachment_integrity_receipt_missing_or_invalid"
  action = "rehash_the_actual_attachment_bytes_before_any_visual_decision"
  exitCode = 75
} else if (contentSha !== uploadedSha) {
  admitted = false
  reason = "uploaded_attachment_hash_mismatch"
  action = "quarantine_only_the_stale_attachment_and_materialize_the_expected_hash_bound_revision"
  exitCode = 77
} else if (!cacheIdentitySafe) {
  admitted = false
  reason = "filename_or_path_keyed_cache_identity_rejected"
  action = "use_content_hash_or_opaque_upload_identity_and_invalidate_filename_keyed_cache_entries"
  exitCode = 77
} else if (sameFilenameReused && !priorDerivedOutputsInvalidated) {
  admitted = false
  reason = "prior_outputs_not_invalidated_after_same_filename_revision"
  action = "invalidate_only_outputs_derived_from_the_old_revision_then_recompute_from_the_verified_bytes"
  exitCode = 75
} else if (!revisionBoundaryVerified) {
  admitted = false
  reason = "current_image_revision_not_proven_at_visual_runtime_boundary"
  action = routeReady
    ? "continue_the_exact_unfinished_visual_step_through_the_verified_hash_bound_route"
    : "start_a_fresh_disposable_task_verify_hash_preview_and_visual_canary_then_bind_the_receipt_to_the_operation"
  exitCode = 75
} else if (!taskStatePreserved || !externalWritesReconciled) {
  admitted = false
  reason = "task_or_write_state_not_reconciled"
  action = "preserve_the_task_and_reconcile_all_artifacts_or_external_writes_before_continuing"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  filename,
  same_filename_reused: sameFilenameReused,
  byte_identity_verified: byteIdentityVerified,
  cache_identity_safe: cacheIdentitySafe,
  revision_boundary_verified: revisionBoundaryVerified,
  continuity_route_ready: routeReady,
}

;(admitted ? process.stdout : process.stderr).write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
