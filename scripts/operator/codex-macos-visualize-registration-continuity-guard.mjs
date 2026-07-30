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
    } else parsed[key] = true
  }
  return parsed
}

function readJson(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function text(value, name, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return ""
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function sha256(value, name, optional = false) {
  const normalized = text(value, name, optional).toLowerCase()
  if (!normalized && optional) return ""
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${name} must be a 64-character SHA-256 digest`)
  return normalized
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJson(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
if (prohibited.test(JSON.stringify({ evidence, route: args.route, provider: args.provider, env: process.env.OPERATOR_ROUTE }))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let taskId
let platform
let appVersion
let pluginVersion
let materializedVariant
let fallbackRoute
let artifactSha256
try {
  operationId = text(evidence.operation_id, "operation_id")
  taskId = text(evidence.task_id, "task_id")
  platform = text(evidence.platform, "platform").toLowerCase()
  appVersion = text(evidence.app_version, "app_version")
  pluginVersion = text(evidence.plugin_version, "plugin_version")
  materializedVariant = text(evidence.materialized_variant, "materialized_variant", true).toLowerCase()
  fallbackRoute = text(evidence.fallback_route, "fallback_route", true).toLowerCase()
  artifactSha256 = sha256(evidence.artifact_sha256, "artifact_sha256", true)
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const macos = platform.includes("darwin") || platform.includes("macos")
const visualizeEnabled = bool(evidence.visualize_enabled, "visualize_enabled")
const productionDispatchEnabled = bool(evidence.production_dispatch_enabled, "production_dispatch_enabled")
const nativeRegistrationPresent = bool(evidence.native_registration_present, "native_registration_present")
const freshTaskDiscoveryPerformed = bool(evidence.fresh_task_discovery_performed, "fresh_task_discovery_performed")
const tryNowUsed = bool(evidence.try_now_used, "try_now_used")
const tryNowUsedNativePath = bool(evidence.try_now_used_native_path, "try_now_used_native_path")
const repeatedBootstrapSuppressed = bool(evidence.repeated_bootstrap_suppressed, "repeated_bootstrap_suppressed")
const bundleOrCacheMutationRequested = bool(evidence.bundle_or_cache_mutation_requested, "bundle_or_cache_mutation_requested")
const taskStateCheckpointed = bool(evidence.task_state_checkpointed, "task_state_checkpointed")
const repositoryWritesReconciled = bool(evidence.repository_writes_reconciled, "repository_writes_reconciled")
const externalWritesReconciled = bool(evidence.external_writes_reconciled, "external_writes_reconciled")
const fallbackCanaryPassed = bool(evidence.fallback_canary_passed, "fallback_canary_passed")
const artifactPathBound = bool(evidence.artifact_path_bound, "artifact_path_bound")
const correctedBuildCanaryPassed = bool(evidence.corrected_build_canary_passed, "corrected_build_canary_passed")

const liveDisabled = materializedVariant === "live-disabled"
const nativeBoundaryBroken = visualizeEnabled && (!productionDispatchEnabled || liveDisabled || !nativeRegistrationPresent)
const approvedFallbackRoutes = new Set(["none", "approved_local_renderer", "static_html_svg_png", "direct_openai_file_artifact"])

let admitted = true
let reason = "visualize_native_registration_verified"
let exitCode = 0

if (!macos) {
  reason = "not_macos_host"
} else if (!approvedFallbackRoutes.has(fallbackRoute || "none")) {
  admitted = false
  reason = "unapproved_visualization_route"
  exitCode = 64
} else if (bundleOrCacheMutationRequested) {
  admitted = false
  reason = "bundled_plugin_or_cache_mutation_forbidden"
  exitCode = 64
} else if (!visualizeEnabled) {
  reason = "visualize_not_enabled"
} else if (!freshTaskDiscoveryPerformed) {
  admitted = false
  reason = "fresh_task_capability_discovery_required"
  exitCode = 75
} else if (!nativeBoundaryBroken) {
  reason = correctedBuildCanaryPassed ? "corrected_visualize_build_verified" : "visualize_native_registration_verified"
} else if (!taskStateCheckpointed || !repositoryWritesReconciled || !externalWritesReconciled) {
  admitted = false
  reason = "operator_state_reconciliation_required_before_visualization_reroute"
  exitCode = 75
} else if (!repeatedBootstrapSuppressed) {
  admitted = false
  reason = "repeated_visualize_bootstrap_must_be_suppressed"
  exitCode = 75
} else if (!fallbackRoute || fallbackRoute === "none") {
  admitted = false
  reason = "explicit_visualization_fallback_required"
  exitCode = 75
} else if (!fallbackCanaryPassed || !artifactPathBound || !artifactSha256) {
  admitted = false
  reason = "fallback_artifact_binding_and_canary_required"
  exitCode = 75
} else if (tryNowUsed && !tryNowUsedNativePath) {
  reason = "native_visualize_unavailable_explicit_artifact_fallback_active"
} else {
  reason = "visualize_rerouted_to_verified_artifact_path"
}

const report = {
  admitted,
  reason,
  operation_id: operationId,
  task_id: taskId,
  platform,
  app_version: appVersion,
  plugin_version: pluginVersion,
  visualize_enabled: visualizeEnabled,
  materialized_variant: materializedVariant || null,
  production_dispatch_enabled: productionDispatchEnabled,
  native_registration_present: nativeRegistrationPresent,
  native_boundary_broken: nativeBoundaryBroken,
  try_now_used: tryNowUsed,
  try_now_used_native_path: tryNowUsedNativePath,
  repeated_bootstrap_suppressed: repeatedBootstrapSuppressed,
  fallback_route: fallbackRoute || "none",
  fallback_canary_passed: fallbackCanaryPassed,
  artifact_path_bound: artifactPathBound,
  artifact_sha256: artifactSha256 || null,
  protocol: admitted
    ? "Treat native Visualize registration as a capability that must be discovered and canaried, not inferred from the plugin chip or Try now. When native registration is absent, keep the task running through a checksum-bound local renderer or direct OpenAI file-artifact path and preserve the original operation and idempotency ledger."
    : "Isolate only the missing native Visualize route. Do not patch the signed app bundle, mutate bundled plugin caches, repeatedly bootstrap the same unavailable capability, or replay completed work. Checkpoint task state, reconcile writes, then route the unfinished visualization through an explicitly approved checksum-bound HTML/SVG/PNG or local renderer path.",
  resume_condition:
    "Resume native Visualize authority after an official corrected build materializes an enabled live variant, production dispatch is enabled, fresh-task discovery exposes the native capability, Plugins Try now exercises that same native path, and repeated artifact-generation canaries pass without fallback substitution.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
