import fs from "node:fs"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, all) => {
  if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true])
  return acc
}, []))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const fail = (reason, code = 2, detail) => {
  console.error(JSON.stringify({ admitted: false, reason, ...(detail ? { detail } : {}) }, null, 2))
  process.exit(code)
}
if (!args.input) fail("missing_input")

let evidence
try {
  const inputPath = path.resolve(String(args.input))
  const stat = fs.lstatSync(inputPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"))
} catch (error) { fail("invalid_evidence", 2, error.message) }

if (prohibited.test(JSON.stringify({ evidence, provider: args.provider || process.env.OPERATOR_PROVIDER, route: args.route || process.env.OPERATOR_ROUTE, gateway: process.env.OPERATOR_GATEWAY }))) fail("prohibited_route_metadata", 64)

const str = (value, name, required = false) => {
  if (value == null || value === "") { if (required) throw new Error(`${name} is required`); return "" }
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}
const bool = (value, name) => {
  if (value == null) return false
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}
const num = (value, name) => {
  if (value == null) return 0
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`)
  return value
}
const obj = (value, name) => {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

let taskId, operationId, idempotencyKey, components, crash, recovery
try {
  taskId = str(evidence.task_id, "task_id", true)
  operationId = str(evidence.operation_id, "operation_id", true)
  idempotencyKey = str(evidence.idempotency_key, "idempotency_key", true)
  components = obj(evidence.components, "components")
  crash = obj(evidence.crash, "crash")
  recovery = obj(evidence.recovery, "recovery")
} catch (error) { fail("malformed_evidence", 2, error.message) }

const exceptionCode = str(crash.exception_code, "crash.exception_code").toLowerCase()
const faultModule = str(crash.fault_module, "crash.fault_module").toLowerCase()
const stackBufferOverrun = ["0xc0000409", "c0000409", "status_stack_buffer_overrun"].includes(exceptionCode) && faultModule === "codex.exe"
const repeatedSignature = num(crash.same_signature_count, "crash.same_signature_count") >= 2
const crashAnomaly = stackBufferOverrun && (repeatedSignature || bool(crash.process_became_unresponsive, "crash.process_became_unresponsive"))

const versionJson = str(components.version_json, "components.version_json")
const commandRunner = str(components.command_runner_version, "components.command_runner_version")
const runtimePackage = str(components.runtime_package_version, "components.runtime_package_version")
const componentSetCoherent = bool(components.component_set_coherent, "components.component_set_coherent")
const releaseManifestVerified = bool(components.release_manifest_verified, "components.release_manifest_verified")
const packageHashesVerified = bool(components.package_hashes_verified, "components.package_hashes_verified")
const componentSkew = bool(components.component_skew_observed, "components.component_skew_observed") || !componentSetCoherent
const anomaly = crashAnomaly || componentSkew

const unsafeRecovery = anomaly && (
  bool(recovery.automatic_task_replay_attempted, "recovery.automatic_task_replay_attempted") ||
  bool(recovery.blind_auto_update_attempted, "recovery.blind_auto_update_attempted") ||
  bool(recovery.unverified_component_replacement_attempted, "recovery.unverified_component_replacement_attempted")
)

const route = str(recovery.continuation_route, "recovery.continuation_route").toLowerCase()
const baseReceipts = bool(recovery.canonical_task_state_reconciled, "recovery.canonical_task_state_reconciled") &&
  bool(recovery.repository_state_reconciled, "recovery.repository_state_reconciled") &&
  bool(recovery.external_writes_reconciled, "recovery.external_writes_reconciled") &&
  bool(recovery.unfinished_action_checkpointed, "recovery.unfinished_action_checkpointed") &&
  bool(recovery.current_installation_preserved, "recovery.current_installation_preserved")
const approvedRoute = new Set(["verified_windows_bundle", "approved_local", "approved_linux"]).has(route)
const windowsBundleReady = route !== "verified_windows_bundle" || (componentSetCoherent && releaseManifestVerified && packageHashesVerified && bool(recovery.cold_start_canary_passed, "recovery.cold_start_canary_passed"))
const crashRouteSafe = !crashAnomaly || route !== "verified_windows_bundle" || bool(recovery.repeated_crash_canary_passed, "recovery.repeated_crash_canary_passed")
const boundedRecovery = !anomaly || (baseReceipts && approvedRoute && windowsBundleReady && crashRouteSafe)

let admitted = true
let reason = "windows_component_set_verified"
let code = 0
if (unsafeRecovery) {
  admitted = false
  reason = "blind_replay_or_component_replacement_forbidden"
  code = 64
} else if (!boundedRecovery) {
  admitted = false
  reason = crashAnomaly ? "windows_codex_crash_state_unreconciled" : "windows_codex_component_skew_unreconciled"
  code = 75
} else if (anomaly && route === "verified_windows_bundle") {
  reason = "verified_windows_bundle_recovered"
} else if (anomaly) {
  reason = "windows_execution_rerouted_after_reconciliation"
}

console.log(JSON.stringify({
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  components: {
    version_json: versionJson || null,
    command_runner_version: commandRunner || null,
    runtime_package_version: runtimePackage || null,
    component_set_coherent: componentSetCoherent,
    component_skew_detected: componentSkew,
    release_manifest_verified: releaseManifestVerified,
    package_hashes_verified: packageHashesVerified,
  },
  crash: {
    stack_buffer_overrun_signature: stackBufferOverrun,
    repeated_signature: repeatedSignature,
    anomaly_detected: crashAnomaly,
  },
  continuation_route: route || null,
  protocol: admitted
    ? "Continue only the exact unfinished action. Preserve the current installation as rollback evidence. Use Windows execution only with one checksum-bound coherent component bundle and passing cold-start/crash canaries; otherwise retain Windows as a control surface and execute through the approved local/Linux route."
    : "Isolate only the affected Windows execution path. Preserve WER data, component versions and hashes, task and repository receipts, and external-write state. Do not replay the task, run blind auto-update loops, or mix component versions.",
  resume_condition: "Resume the native Windows route after one coherent checksum-verified bundle passes version, doctor, cold-start, active-turn, and repeated-crash canaries; otherwise continue through the approved local/Linux executor.",
}, null, 2))
process.exit(code)
