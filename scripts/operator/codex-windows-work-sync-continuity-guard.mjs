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

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i

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

let taskId
let operationId
let idempotencyKey
let objectType
let source
let visibility
let recovery

try {
  taskId = nonEmptyString(evidence.task_id, "task_id")
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  idempotencyKey = nonEmptyString(evidence.idempotency_key, "idempotency_key")
  objectType = nonEmptyString(evidence.object_type, "object_type").toLowerCase()
  source = optionalObject(evidence.source, "source")
  visibility = optionalObject(evidence.visibility, "visibility")
  recovery = optionalObject(evidence.recovery, "recovery")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const supportedTypes = new Set(["continue_work", "scheduled", "project_work"])
if (!supportedTypes.has(objectType)) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_work_object_type" }, null, 2))
  process.exit(2)
}

const sourceClient = optionalString(source.client, "source.client").toLowerCase()
const sourceBuild = optionalString(source.build, "source.build")
const createdOnWindows = boolean(source.created_on_windows, "source.created_on_windows")
const expectedCloudObject = boolean(source.expected_cloud_object, "source.expected_cloud_object", true)
const visibleWindows = boolean(visibility.windows, "visibility.windows")
const visibleWeb = boolean(visibility.web, "visibility.web")
const visibleMobile = boolean(visibility.mobile, "visibility.mobile")
const canonicalRecordId = optionalString(visibility.canonical_record_id, "visibility.canonical_record_id")

const sourceObjectPreserved = boolean(recovery.source_object_preserved, "recovery.source_object_preserved")
const localReceiptHashed = boolean(recovery.local_receipt_hashed, "recovery.local_receipt_hashed")
const externalWritesReconciled = boolean(recovery.external_writes_reconciled, "recovery.external_writes_reconciled")
const duplicateReplacementCreated = boolean(recovery.duplicate_replacement_created, "recovery.duplicate_replacement_created")
const windowsCreationBlocked = boolean(recovery.windows_work_creation_blocked, "recovery.windows_work_creation_blocked")
const canonicalCreationAttempted = boolean(recovery.canonical_creation_attempted, "recovery.canonical_creation_attempted")
const canonicalCreationVerified = boolean(recovery.canonical_creation_verified, "recovery.canonical_creation_verified")
const scheduleTriggerVerified = boolean(recovery.schedule_trigger_verified, "recovery.schedule_trigger_verified")
const continuationRoute = optionalString(recovery.continuation_route, "recovery.continuation_route").toLowerCase()

const windowsWorkObject = sourceClient === "windows_app" && createdOnWindows && expectedCloudObject
const cloudProjectionMissing = windowsWorkObject && visibleWindows && (!visibleWeb || !visibleMobile)
const scheduledAuthorityMissing = objectType === "scheduled" && cloudProjectionMissing
const safeRoutes = new Set(["web_control_plane", "approved_local", "approved_linux"])
const safeRouteSelected = safeRoutes.has(continuationRoute)
const canonicalRecoveryComplete =
  sourceObjectPreserved &&
  localReceiptHashed &&
  externalWritesReconciled &&
  windowsCreationBlocked &&
  canonicalCreationAttempted &&
  canonicalCreationVerified &&
  Boolean(canonicalRecordId) &&
  safeRouteSelected &&
  (!scheduledAuthorityMissing || scheduleTriggerVerified)

let admitted = true
let reason = "windows_work_sync_continuity_verified"
let exitCode = 0

if (duplicateReplacementCreated) {
  admitted = false
  reason = "duplicate_work_object_creation_forbidden"
  exitCode = 64
} else if (cloudProjectionMissing) {
  if (!canonicalRecoveryComplete) {
    admitted = false
    reason = scheduledAuthorityMissing
      ? "windows_scheduled_object_not_canonical"
      : "windows_work_object_sync_unreconciled"
    exitCode = 75
  } else {
    reason = scheduledAuthorityMissing
      ? "scheduled_object_recreated_on_canonical_control_plane"
      : "work_object_recreated_on_canonical_control_plane"
  }
}

const result = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  object_type: objectType,
  source_build: sourceBuild,
  cloud_projection_missing: cloudProjectionMissing,
  continuation_route: continuationRoute || "windows_app",
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
