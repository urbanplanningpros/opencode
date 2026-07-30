import fs from "node:fs"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, all) => {
  if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true])
  return acc
}, []))

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const fail = (reason, code = 2, detail) => {
  const output = JSON.stringify({ admitted: false, reason, ...(detail ? { detail } : {}) }, null, 2)
  if (args.json) console.log(output)
  else console.error(output)
  process.exit(code)
}

if (!args.input) fail("missing_input")

let evidence
try {
  const inputPath = path.resolve(String(args.input))
  const stat = fs.lstatSync(inputPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"))
} catch (error) {
  fail("invalid_evidence", 2, error.message)
}

if (prohibited.test(JSON.stringify({
  evidence,
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
}))) fail("prohibited_route_metadata", 64)

const asString = (value, name, required = false) => {
  if (value == null || value === "") {
    if (required) throw new Error(`${name} is required`)
    return ""
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}
const asBoolean = (value, name) => {
  if (value == null) return false
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}
const asNumber = (value, name) => {
  if (value == null) return 0
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`)
  return value
}
const asObject = (value, name) => {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

let taskId, operationId, idempotencyKey, payload, crash, recovery
try {
  taskId = asString(evidence.task_id, "task_id", true)
  operationId = asString(evidence.operation_id, "operation_id", true)
  idempotencyKey = asString(evidence.idempotency_key, "idempotency_key", true)
  payload = asObject(evidence.payload, "payload")
  crash = asObject(evidence.crash, "crash")
  recovery = asObject(evidence.recovery, "recovery")
} catch (error) {
  fail("malformed_evidence", 2, error.message)
}

const serializedBytes = asNumber(payload.serialized_bytes, "payload.serialized_bytes")
const duplicatedInlineImageBytes = asNumber(payload.duplicated_inline_image_bytes, "payload.duplicated_inline_image_bytes")
const inlineImageCount = asNumber(payload.inline_image_count, "payload.inline_image_count")
const containsBase64Images = asBoolean(payload.contains_base64_images, "payload.contains_base64_images")
const taskReopenRequested = asBoolean(payload.task_reopen_requested, "payload.task_reopen_requested")

const rendererCrashed = asBoolean(crash.renderer_crashed, "crash.renderer_crashed")
const crashSignature = asString(crash.signature, "crash.signature")
const reproducedAcrossBuilds = asNumber(crash.reproduced_build_count, "crash.reproduced_build_count")
const serializerSignature = /valueserializer|hascustomhostobject|exc_breakpoint|sigtrap/i.test(crashSignature)
const oversizedPayload = serializedBytes >= 256 * 1024 * 1024
const imageHeavy = containsBase64Images && (duplicatedInlineImageBytes >= 128 * 1024 * 1024 || inlineImageCount >= 100)
const affected = taskReopenRequested && ((rendererCrashed && serializerSignature) || (oversizedPayload && imageHeavy))

const originalTaskPreserved = asBoolean(recovery.original_task_preserved, "recovery.original_task_preserved")
const removedFromAutoResume = asBoolean(recovery.removed_from_auto_resume, "recovery.removed_from_auto_resume")
const workspaceFilesVerified = asBoolean(recovery.workspace_files_verified, "recovery.workspace_files_verified")
const externalWritesReconciled = asBoolean(recovery.external_writes_reconciled, "recovery.external_writes_reconciled")
const compactCheckpointCreated = asBoolean(recovery.compact_checkpoint_created, "recovery.compact_checkpoint_created")
const checkpointSha256 = asString(recovery.checkpoint_sha256, "recovery.checkpoint_sha256")
const inlineImagesExternalized = asBoolean(recovery.inline_images_externalized, "recovery.inline_images_externalized")
const artifactManifestVerified = asBoolean(recovery.artifact_manifest_verified, "recovery.artifact_manifest_verified")
const approvedExecutorVerified = asBoolean(recovery.approved_executor_verified, "recovery.approved_executor_verified")
const continuationRoute = asString(recovery.continuation_route, "recovery.continuation_route").toLowerCase()
const automaticReopenAttempted = asBoolean(recovery.automatic_reopen_attempted, "recovery.automatic_reopen_attempted")
const automaticReplayAttempted = asBoolean(recovery.automatic_replay_attempted, "recovery.automatic_replay_attempted")
const destructiveCleanupAttempted = asBoolean(recovery.destructive_cleanup_attempted, "recovery.destructive_cleanup_attempted")

const validCheckpointHash = /^[a-f0-9]{64}$/i.test(checkpointSha256)
const allowedRoutes = new Set(["fresh_task_compact_checkpoint", "workspace_files_direct", "approved_local", "approved_linux"])
const unsafeRecovery = affected && (automaticReopenAttempted || automaticReplayAttempted || destructiveCleanupAttempted)
const freshTaskRecovered = continuationRoute === "fresh_task_compact_checkpoint" &&
  compactCheckpointCreated && validCheckpointHash && inlineImagesExternalized && artifactManifestVerified
const workspaceDirectRecovered = continuationRoute === "workspace_files_direct" && workspaceFilesVerified
const approvedRouteRecovered = new Set(["approved_local", "approved_linux"]).has(continuationRoute) &&
  approvedExecutorVerified && workspaceFilesVerified
const boundedRecovery = !affected || (
  originalTaskPreserved &&
  removedFromAutoResume &&
  workspaceFilesVerified &&
  externalWritesReconciled &&
  allowedRoutes.has(continuationRoute) &&
  (freshTaskRecovered || workspaceDirectRecovered || approvedRouteRecovered)
)

let admitted = true
let reason = "saved_task_payload_continuity_verified"
let code = 0
if (unsafeRecovery) {
  admitted = false
  reason = "unsafe_saved_task_reopen_replay_or_cleanup_forbidden"
  code = 64
} else if (!boundedRecovery) {
  admitted = false
  reason = "oversized_saved_task_state_unreconciled"
  code = 75
} else if (affected && freshTaskRecovered) {
  reason = "fresh_task_checkpoint_recovery_verified"
} else if (affected && workspaceDirectRecovered) {
  reason = "workspace_direct_recovery_verified"
} else if (affected) {
  reason = "approved_executor_saved_task_recovery_verified"
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  payload: {
    serialized_bytes: serializedBytes,
    duplicated_inline_image_bytes: duplicatedInlineImageBytes,
    inline_image_count: inlineImageCount,
    contains_base64_images: containsBase64Images,
    oversized_payload: oversizedPayload,
    image_heavy: imageHeavy,
    task_reopen_requested: taskReopenRequested,
  },
  crash: {
    renderer_crashed: rendererCrashed,
    signature: crashSignature || null,
    serializer_signature_detected: serializerSignature,
    reproduced_build_count: reproducedAcrossBuilds,
    affected,
  },
  recovery: {
    continuation_route: continuationRoute || null,
    original_task_preserved: originalTaskPreserved,
    removed_from_auto_resume: removedFromAutoResume,
    workspace_files_verified: workspaceFilesVerified,
    external_writes_reconciled: externalWritesReconciled,
    compact_checkpoint_created: compactCheckpointCreated,
    checkpoint_sha256_valid: validCheckpointHash,
    inline_images_externalized: inlineImagesExternalized,
    artifact_manifest_verified: artifactManifestVerified,
    approved_executor_verified: approvedExecutorVerified,
  },
  protocol: admitted
    ? "Keep the oversized saved task preserved but out of automatic resume paths. Continue from verified workspace files or one compact checkpoint whose images are externalized into hashed artifacts. Retain the same operation and idempotency ledger and execute only the exact unfinished action."
    : "Pause only reopening the affected saved task. Preserve the task and workspace, reconcile possible durable writes, remove the task from automatic resume, and do not delete or rewrite its history. Continue through verified workspace files, a compact image-externalized checkpoint, or an approved local/Linux executor.",
  resume_condition: "Resume native saved-task reopening only after a corrected stable build safely opens a disposable image-heavy canary without renderer failure and without rematerializing large duplicated inline payloads.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(code)
