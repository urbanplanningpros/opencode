#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) parsed[key] = true
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function number(value) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedExecutionRoutes = new Set([
  "typescript_sdk_structured",
  "direct_codex_cli_argv",
  "python_sdk_config_overrides",
  "approved_local_wrapper",
])

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-typescript-config-override-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read TypeScript SDK config evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.test(`${provider} ${route}`)) blocked.push("prohibited_route_metadata")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const sdkLanguage = text(evidence.sdk_language).toLowerCase()
const sdkVersion = text(evidence.codex_sdk_version)
const executionRoute = text(evidence.execution_route).toLowerCase()
const permissionProfileId = text(evidence.process_permission_profile_id)
const configReceiptSha256 = text(evidence.config_receipt_sha256).toLowerCase()
const concurrentProcessCount = number(evidence.concurrent_process_count)

if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!sdkLanguage) blocked.push("sdk_language_missing")
if (!sdkVersion) blocked.push("codex_sdk_version_missing")
if (!permissionProfileId) blocked.push("process_permission_profile_id_missing")
if (!/^[a-f0-9]{64}$/.test(configReceiptSha256)) blocked.push("config_receipt_sha256_invalid")
if (Number.isNaN(concurrentProcessCount)) blocked.push("concurrent_process_count_invalid")
if (!approvedExecutionRoutes.has(executionRoute)) blocked.push("unapproved_execution_route")

const mapKeys = Array.isArray(evidence.config_map_keys) ? evidence.config_map_keys.map(text).filter(Boolean) : []
const rawOverrides = Array.isArray(evidence.raw_config_arguments) ? evidence.raw_config_arguments.map(text).filter(Boolean) : []
const dottedMapKey = mapKeys.some((key) => key.includes(".") || key.startsWith(".") || key.includes("/."))
const typescriptStructured = sdkLanguage === "typescript" && executionRoute === "typescript_sdk_structured"
const sharedConfigMutation = evidence.shared_codex_home_config_mutation_requested === true
const shellInterpretationDisabled = evidence.shell_interpretation_disabled === true
const argvBindingVerified = evidence.separate_argv_binding_verified === true
const inlineTomlTableUsed = evidence.inline_toml_table_used === true
const rawOverrideSupportAvailable = evidence.typescript_sdk_raw_override_support_available === true
const perProcessConfigIsolated = evidence.per_process_config_isolated === true
const postLaunchConfigReadback = evidence.post_launch_config_readback_passed === true
const mutationAuthorityRequested = evidence.mutation_authority_requested === true
const sharedConfigRestored = evidence.shared_config_restored_after_launch === true

const lossySerializationRisk = typescriptStructured && dottedMapKey && !rawOverrideSupportAvailable
const sharedConfigRaceRisk = sharedConfigMutation && concurrentProcessCount > 1
const losslessRawRoute =
  ["direct_codex_cli_argv", "python_sdk_config_overrides", "approved_local_wrapper"].includes(executionRoute) &&
  rawOverrides.length > 0 &&
  shellInterpretationDisabled &&
  argvBindingVerified &&
  inlineTomlTableUsed &&
  perProcessConfigIsolated

if (lossySerializationRisk && mutationAuthorityRequested) blocked.push("lossy_dotted_map_key_serialization")
if (sharedConfigRaceRisk) blocked.push("shared_codex_home_permission_race")
if (executionRoute !== "typescript_sdk_structured" && rawOverrides.length === 0) blocked.push("raw_config_argument_missing")
if (rawOverrides.length > 0 && !shellInterpretationDisabled) blocked.push("shell_interpretation_must_be_disabled")
if (rawOverrides.length > 0 && !argvBindingVerified) blocked.push("separate_argv_binding_required")
if (rawOverrides.length > 0 && !inlineTomlTableUsed) blocked.push("inline_toml_table_required_for_dotted_map_keys")
if (executionRoute === "approved_local_wrapper" && provider !== "approved-local") warnings.push("local_wrapper_provider_metadata_should_be_approved_local")
if (sharedConfigMutation && !sharedConfigRestored) warnings.push("shared_config_restoration_not_verified")

if (lossySerializationRisk) remediation.push("replace_structured_typescript_config_with_lossless_per_process_override")
if (lossySerializationRisk && executionRoute === "typescript_sdk_structured") {
  remediation.push("use_direct_codex_cli_argv_or_official_python_sdk_config_overrides")
}
if (dottedMapKey && rawOverrides.length === 0) remediation.push("serialize_map_as_single_inline_toml_table")
if (!postLaunchConfigReadback) remediation.push("verify_effective_permission_config_after_process_start")
if (!perProcessConfigIsolated) remediation.push("isolate_permission_config_per_process")

const compatibleConfig =
  !lossySerializationRisk &&
  !sharedConfigRaceRisk &&
  (executionRoute === "typescript_sdk_structured" || losslessRawRoute) &&
  perProcessConfigIsolated &&
  postLaunchConfigReadback

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: new Date().toISOString(),
  status,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  task_id: taskId || null,
  operation_id: operationId || null,
  sdk_language: sdkLanguage || null,
  codex_sdk_version: sdkVersion || null,
  execution_route: executionRoute || null,
  dotted_map_key_detected: dottedMapKey,
  lossy_serialization_risk: lossySerializationRisk,
  shared_config_race_risk: sharedConfigRaceRisk,
  lossless_raw_route: losslessRawRoute,
  compatible_config: compatibleConfig,
  continuity_route:
    status === "compatible"
      ? "launch each Codex process with a lossless permission receipt and post-start readback through the structured SDK only when all keys are representable, otherwise through direct Codex CLI argv, the official Python SDK config_overrides path, or a reviewed approved-local wrapper"
      : "do not mutate shared CODEX_HOME permissions and do not launch a TypeScript SDK process with dotted map keys through recursive flattening; preserve the operation receipt and continue through a lossless per-process direct OpenAI or approved-local argv path",
  resume_condition:
    "Resume the affected TypeScript automation after each user-controlled map key is represented losslessly, every raw override is passed as a separate non-shell argv element, permission configuration is isolated per process, and post-launch readback confirms the intended effective profile.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex TypeScript config override boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
