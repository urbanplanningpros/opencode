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
const asObject = (value, name) => {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

let taskId, operationId, idempotencyKey, runtime, startup, recovery
try {
  taskId = asString(evidence.task_id, "task_id", true)
  operationId = asString(evidence.operation_id, "operation_id", true)
  idempotencyKey = asString(evidence.idempotency_key, "idempotency_key", true)
  runtime = asObject(evidence.runtime, "runtime")
  startup = asObject(evidence.startup, "startup")
  recovery = asObject(evidence.recovery, "recovery")
} catch (error) {
  fail("malformed_evidence", 2, error.message)
}

const platform = asString(runtime.platform, "runtime.platform").toLowerCase()
const codexVersion = asString(runtime.codex_version, "runtime.codex_version")
const cwdRaw = asString(runtime.cwd_raw, "runtime.cwd_raw")
const procSelfCwd = asString(runtime.proc_self_cwd, "runtime.proc_self_cwd")
const nestedMountNamespace = asBoolean(runtime.nested_mount_namespace, "runtime.nested_mount_namespace")

const appServerRequested = asBoolean(startup.app_server_requested, "startup.app_server_requested")
const appServerStarted = asBoolean(startup.app_server_started, "startup.app_server_started")
const configLoadError = asString(startup.config_load_error, "startup.config_load_error")
const currentDirError = asString(startup.current_dir_error, "startup.current_dir_error")

const unreachablePrefix = cwdRaw.toLowerCase().startsWith("(unreachable)/")
const configEnoent = /no such file or directory|os error 2|enoent/i.test(`${configLoadError} ${currentDirError}`)
const affected = platform.includes("linux") && appServerRequested && (unreachablePrefix || (nestedMountNamespace && configEnoent))

const automaticRelaunchAttempted = asBoolean(recovery.automatic_relaunch_attempted, "recovery.automatic_relaunch_attempted")
const pathPrefixStrippedOnly = asBoolean(recovery.path_prefix_stripped_without_reanchor, "recovery.path_prefix_stripped_without_reanchor")
const inheritedWdOnly = asBoolean(recovery.inherited_or_nsenter_wd_only, "recovery.inherited_or_nsenter_wd_only")
const explicitChdirInsideNamespace = asBoolean(recovery.explicit_chdir_inside_namespace, "recovery.explicit_chdir_inside_namespace")
const canonicalCwdVerified = asBoolean(recovery.canonical_cwd_verified, "recovery.canonical_cwd_verified")
const configPathsReadable = asBoolean(recovery.config_paths_readable, "recovery.config_paths_readable")
const startupCanaryPassed = asBoolean(recovery.startup_canary_passed, "recovery.startup_canary_passed")
const canonicalTurnStateReconciled = asBoolean(recovery.canonical_turn_state_reconciled, "recovery.canonical_turn_state_reconciled")
const externalWritesReconciled = asBoolean(recovery.external_writes_reconciled, "recovery.external_writes_reconciled")
const checkpointPreserved = asBoolean(recovery.checkpoint_preserved, "recovery.checkpoint_preserved")
const approvedExecutorVerified = asBoolean(recovery.approved_executor_verified, "recovery.approved_executor_verified")
const continuationRoute = asString(recovery.continuation_route, "recovery.continuation_route").toLowerCase()

const allowedRoutes = new Set(["same_namespace_explicit_chdir", "approved_local", "approved_linux"])
const unsafeRecovery = affected && (automaticRelaunchAttempted || pathPrefixStrippedOnly || inheritedWdOnly)
const sameNamespaceRecovered = continuationRoute === "same_namespace_explicit_chdir" &&
  explicitChdirInsideNamespace && canonicalCwdVerified && configPathsReadable && startupCanaryPassed
const externalRouteRecovered = new Set(["approved_local", "approved_linux"]).has(continuationRoute) &&
  approvedExecutorVerified && canonicalCwdVerified && startupCanaryPassed
const boundedRecovery = !affected || (
  checkpointPreserved &&
  canonicalTurnStateReconciled &&
  externalWritesReconciled &&
  allowedRoutes.has(continuationRoute) &&
  (sameNamespaceRecovered || externalRouteRecovered)
)

let admitted = true
let reason = "linux_cwd_continuity_verified"
let code = 0
if (unsafeRecovery) {
  admitted = false
  reason = "unsafe_unreachable_cwd_recovery_forbidden"
  code = 64
} else if (!boundedRecovery) {
  admitted = false
  reason = "unreachable_cwd_startup_state_unreconciled"
  code = 75
} else if (affected && sameNamespaceRecovered) {
  reason = "same_namespace_explicit_chdir_verified"
} else if (affected) {
  reason = "approved_executor_cwd_recovery_verified"
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  runtime: {
    platform,
    codex_version: codexVersion || null,
    cwd_raw: cwdRaw || null,
    proc_self_cwd: procSelfCwd || null,
    nested_mount_namespace: nestedMountNamespace,
    unreachable_prefix_detected: unreachablePrefix,
  },
  startup: {
    app_server_requested: appServerRequested,
    app_server_started: appServerStarted,
    config_enoent_detected: configEnoent,
    affected,
  },
  recovery: {
    continuation_route: continuationRoute || null,
    explicit_chdir_inside_namespace: explicitChdirInsideNamespace,
    canonical_cwd_verified: canonicalCwdVerified,
    config_paths_readable: configPathsReadable,
    startup_canary_passed: startupCanaryPassed,
    canonical_turn_state_reconciled: canonicalTurnStateReconciled,
    external_writes_reconciled: externalWritesReconciled,
    checkpoint_preserved: checkpointPreserved,
    approved_executor_verified: approvedExecutorVerified,
  },
  protocol: admitted
    ? "Launch Codex only after an explicit chdir inside the effective mount namespace or through a verified approved executor. Preserve the same operation ledger, verify the canonical cwd and config paths, pass an app-server startup canary, and continue only the exact unfinished action."
    : "Isolate only the affected app-server startup path. Preserve task, operation, repository, and external-write receipts. Do not strip the kernel prefix, rely only on nsenter --wd, or enter a relaunch loop. Re-anchor with an explicit in-namespace chdir or route the exact unfinished action through an approved local/Linux executor after reconciliation.",
  resume_condition: "Resume the affected app-server path only after getcwd returns a reachable absolute path, config paths are readable, the startup canary passes, canonical task state and possible writes are reconciled, and the selected route is explicitly approved.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(code)
