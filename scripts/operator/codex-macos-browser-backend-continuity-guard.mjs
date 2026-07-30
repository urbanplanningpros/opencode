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
const sha256Pattern = /^[a-f0-9]{64}$/
const args = parseArgs(process.argv.slice(2))

if (!args.input) {
  console.error("Usage: node scripts/operator/codex-macos-browser-backend-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read macOS browser-backend evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const fallbackTarget = text(evidence.fallback_target).toLowerCase() || "none"
const allowedFallbacks = new Set([
  "none",
  "official_pinned_desktop_26_721_41059",
  "authorized_local_browser_executor",
  "approved_macos_browser_executor",
  "direct_openai_without_browser",
])

if (!provider) blocked.push("routing_provider_missing")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (prohibited.test(`${provider} ${route} ${fallbackTarget}`)) blocked.push("prohibited_route_metadata")
if (!allowedFallbacks.has(fallbackTarget)) blocked.push("unapproved_fallback_target")

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const desktopVersion = text(evidence.desktop_version)
const browserPluginVersion = text(evidence.browser_plugin_version)
const browserError = text(evidence.browser_error)
const backendList = Array.isArray(evidence.browser_backends) ? evidence.browser_backends.map((item) => text(item)).filter(Boolean) : []

if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")

const macos = platform.includes("mac") || platform.includes("darwin")
const affectedBuild = desktopVersion === "26.721.81911" || desktopVersion.startsWith("26.721.81911.")
const skillPresent = evidence.browser_skill_present === true
const nodeRuntimeAvailable = evidence.node_runtime_available === true
const bootstrapCompleted = evidence.browser_bootstrap_completed === true
const noBackend = backendList.length === 0
const noBrowserError = /no browser is available|browser backend.*unavailable/i.test(browserError)
const incident = macos && affectedBuild && skillPresent && nodeRuntimeAvailable && bootstrapCompleted && noBackend && noBrowserError

const browserControlRequired = evidence.browser_control_required === true
const taskStatePreserved = evidence.task_state_preserved === true
const externalWritesReconciled = evidence.external_writes_reconciled === true
const automaticReplayRequested = evidence.automatic_task_replay_requested === true
const repeatedBootstrapAttempts = Number(evidence.bootstrap_attempt_count || 0)

if (!Number.isInteger(repeatedBootstrapAttempts) || repeatedBootstrapAttempts < 0) blocked.push("bootstrap_attempt_count_invalid")
if (automaticReplayRequested) blocked.push("automatic_task_replay_forbidden")

if (incident) {
  if (!taskStatePreserved) blocked.push("task_state_must_be_preserved")
  if (!externalWritesReconciled) blocked.push("external_writes_must_be_reconciled")
  if (repeatedBootstrapAttempts > 1) warnings.push("suppress_repeated_identical_browser_bootstrap_attempts")

  if (!browserControlRequired && fallbackTarget === "none") {
    warnings.push("isolate_only_in_app_browser_and_continue_unaffected_work")
  }

  if (browserControlRequired && fallbackTarget === "none") {
    blocked.push("browser_control_requires_approved_fallback")
  }
}

if (fallbackTarget === "official_pinned_desktop_26_721_41059") {
  const sourceVerified = evidence.official_openai_package_source_verified === true
  const packageSha = text(evidence.official_package_sha256).toLowerCase()
  const rollbackPreserved = evidence.current_installation_rollback_preserved === true
  const canaryPassed = evidence.browser_discovery_canary_passed === true
  const backendDiscovered = evidence.browser_backend_discovered_after_fallback === true
  const autoUpdatePinned = evidence.auto_update_pinned_until_fix === true

  if (!sourceVerified) blocked.push("official_openai_package_source_verification_required")
  if (!sha256Pattern.test(packageSha)) blocked.push("official_package_sha256_required")
  if (!rollbackPreserved) blocked.push("current_installation_rollback_receipt_required")
  if (!autoUpdatePinned) blocked.push("temporary_update_pin_required")
  if (!canaryPassed || !backendDiscovered) remediation.push("run_disposable_browser_discovery_and_navigation_canary")
}

if (["authorized_local_browser_executor", "approved_macos_browser_executor"].includes(fallbackTarget)) {
  if (evidence.explicit_local_route_authorized !== true) blocked.push("explicit_local_route_authorization_required")
  if (!sha256Pattern.test(text(evidence.local_executor_receipt_sha256).toLowerCase())) blocked.push("local_executor_receipt_sha256_required")
  if (evidence.browser_discovery_canary_passed !== true) remediation.push("run_disposable_local_browser_canary")
}

if (fallbackTarget === "direct_openai_without_browser" && browserControlRequired) {
  blocked.push("browser_required_operation_cannot_use_non_browser_route")
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
  desktop_version: desktopVersion || null,
  browser_plugin_version: browserPluginVersion || null,
  browser_backend_incident: incident,
  fallback_target: fallbackTarget,
  continuity_route:
    incident
      ? browserControlRequired
        ? "preserve the canonical task and exact operation ledger, isolate only the missing in-app browser backend, then continue through a checksum-verified official pinned desktop build or an explicitly authorized local macOS browser executor"
        : "continue shell, repository, connector, API, and automation work while isolating only the unavailable in-app browser backend"
      : "current pinned direct OpenAI or explicitly approved local route",
  resume_condition:
    "Restore current-build in-app browser authority only after a corrected stable OpenAI desktop build registers the iab backend after bootstrap and passes repeated discovery, navigation, read, and idempotent-write canaries without task replay.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex macOS browser-backend boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
  if (result.warnings.length > 0) console.error(`Warnings: ${result.warnings.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
