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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-linux-chrome-bootstrap-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read Linux Chrome bootstrap evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.test(`${provider} ${route} ${text(evidence.fallback_target)}`)) blocked.push("prohibited_route_metadata")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const cliVersion = text(evidence.codex_cli_version)
const pluginVersion = text(evidence.chrome_plugin_version)
const importError = text(evidence.browser_client_import_error)
const blockedModule = text(evidence.blocked_module).toLowerCase()
const fallbackTarget = text(evidence.fallback_target).toLowerCase() || "none"
const approvedFallback = new Set([
  "none",
  "authorized_local_browser_executor",
  "approved_linux_browser_executor",
  "direct_openai_without_browser",
]).has(fallbackTarget)

if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")
if (!approvedFallback) blocked.push("unapproved_fallback_target")

const linux = platform.includes("linux") && !platform.includes("wsl")
const nodeReplAvailable = evidence.node_repl_available === true
const extensionConnected = evidence.chrome_extension_connected === true
const agentDefined = evidence.global_agent_defined === true
const browserControlRequired = evidence.browser_control_required === true
const taskStatePreserved = evidence.task_state_preserved === true
const externalWritesReconciled = evidence.external_writes_reconciled === true
const bootstrapRetryCount = Number(evidence.bootstrap_retry_count || 0)
const broadNodePermissionRequested = evidence.broad_node_builtin_permission_requested === true
const bundledCacheEditedInPlace = evidence.bundled_plugin_cache_edited_in_place === true
const unverifiedShimRequested = evidence.unverified_browser_client_shim_requested === true
const shimVerified = evidence.browser_client_shim_verified === true
const shimSourceSha256 = text(evidence.browser_client_shim_source_sha256).toLowerCase()
const shimOutputSha256 = text(evidence.browser_client_shim_output_sha256).toLowerCase()
const browserCanaryPassed = evidence.browser_control_canary_passed === true

if (!Number.isInteger(bootstrapRetryCount) || bootstrapRetryCount < 0) blocked.push("bootstrap_retry_count_invalid")
if (broadNodePermissionRequested) blocked.push("broad_node_builtin_permission_forbidden")
if (bundledCacheEditedInPlace) blocked.push("bundled_plugin_cache_edit_forbidden")
if (unverifiedShimRequested) blocked.push("unverified_browser_client_shim_forbidden")

const nodeProcessDenied = /node:process/i.test(importError) && /not allowed|blocked|denied/i.test(importError)
const bootstrapIncident = linux && nodeReplAvailable && extensionConnected && nodeProcessDenied && blockedModule === "node:process" && !agentDefined

if (bootstrapIncident && bootstrapRetryCount > 1) warnings.push("suppress_repeated_identical_bootstrap_retries")
if (bootstrapIncident && !taskStatePreserved) blocked.push("task_state_must_be_preserved")
if (bootstrapIncident && !externalWritesReconciled) blocked.push("external_writes_must_be_reconciled")

if (bootstrapIncident && browserControlRequired) {
  if (fallbackTarget === "none" && !shimVerified) {
    blocked.push("browser_control_requires_verified_approved_fallback_or_shim")
  }
  if (shimVerified) {
    if (!/^[a-f0-9]{64}$/.test(shimSourceSha256)) blocked.push("shim_source_sha256_required")
    if (!/^[a-f0-9]{64}$/.test(shimOutputSha256)) blocked.push("shim_output_sha256_required")
    if (!browserCanaryPassed) remediation.push("run_disposable_browser_control_canary")
  }
}

if (bootstrapIncident && !browserControlRequired && fallbackTarget === "none") {
  remediation.push("disable_only_bundled_chrome_control_for_this_operation")
}

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
  platform: platform || null,
  codex_cli_version: cliVersion || null,
  chrome_plugin_version: pluginVersion || null,
  bootstrap_incident: bootstrapIncident,
  fallback_target: fallbackTarget,
  continuity_route:
    status === "compatible"
      ? bootstrapIncident
        ? "continue the exact operation through a checksum-bound reviewed browser shim or an explicitly approved local browser executor; unaffected shell, repository, connector, and API work continues"
        : "current pinned direct OpenAI or approved-local route"
      : "preserve task state, suppress repeated bootstrap retries, isolate only bundled Chrome control, reconcile writes, and select a verified approved browser route or checksum-bound reviewed shim",
  resume_condition:
    "Restore bundled Linux Chrome-control authority only after a corrected stable plugin imports in node_repl without broadening Node builtin permissions, defines the browser runtime, discovers the connected extension, and passes repeated read and idempotent-write canaries.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex Linux Chrome bootstrap boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
