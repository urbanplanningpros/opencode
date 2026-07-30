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
const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-windows-control-surface-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read Windows control-surface evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const rerouteTarget = text(evidence.reroute_target).toLowerCase() || "none"
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.test(`${provider} ${route} ${rerouteTarget}`)) blocked.push("prohibited_route_metadata")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")
if (!new Set(["none", "approved_web_control_plane", "approved_linux_vps", "authorized_local_linux", "direct_github_connector"]).has(rerouteTarget)) {
  blocked.push("unapproved_reroute_target")
}

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const desktopRelease = text(evidence.desktop_release)
const storePackage = text(evidence.store_package)
const cliVersion = text(evidence.codex_cli_version)
if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")

const windows = platform.includes("windows")
const wmiStarts30s = number(evidence.wmi_inventory_powershell_starts_30s)
const powershellStarts30s = number(evidence.total_powershell_starts_30s)
const conhostStarts30s = number(evidence.conhost_starts_30s)
const gitStarts60s = number(evidence.git_starts_60s)
const inputDelayMs = number(evidence.maximum_low_level_input_delay_ms)
for (const [name, value] of Object.entries({ wmiStarts30s, powershellStarts30s, conhostStarts30s, gitStarts60s, inputDelayMs })) {
  if (Number.isNaN(value)) blocked.push(`${name}_invalid`)
}

const systemWideInputLag = evidence.system_wide_input_lag_observed === true
const automaticGitOriginDiscovery = evidence.automatic_git_origin_discovery_observed === true
const desktopExecutionIsolated = evidence.desktop_execution_isolated === true
const processEvidencePreserved = evidence.process_evidence_preserved === true
const canonicalStateReconciled = evidence.canonical_task_state_reconciled === true
const externalWritesReconciled = evidence.external_writes_reconciled === true
const signedStorePackageModified = evidence.signed_store_package_modified === true
const buildSpecificAsarPatchApplied = evidence.build_specific_asar_patch_applied === true
const genericProcessKillRequested = evidence.generic_process_kill_requested === true

if (signedStorePackageModified) blocked.push("signed_store_package_modification_forbidden")
if (buildSpecificAsarPatchApplied) blocked.push("unsupported_build_specific_asar_patch_forbidden")
if (genericProcessKillRequested) blocked.push("generic_process_kill_forbidden")

const processDiscoveryIncident =
  windows &&
  ((wmiStarts30s >= 3 && systemWideInputLag) ||
    (wmiStarts30s > 0 && inputDelayMs >= 100) ||
    (automaticGitOriginDiscovery && gitStarts60s >= 60))

if (processDiscoveryIncident && !processEvidencePreserved) blocked.push("process_evidence_must_be_preserved")
if (processDiscoveryIncident && !canonicalStateReconciled) blocked.push("canonical_task_state_must_be_reconciled")
if (processDiscoveryIncident && !externalWritesReconciled) blocked.push("external_writes_must_be_reconciled")
if (processDiscoveryIncident && !desktopExecutionIsolated) remediation.push("isolate_windows_desktop_execution_surface")
if (processDiscoveryIncident && rerouteTarget === "none") remediation.push("select_approved_non_desktop_execution_route")
if (powershellStarts30s >= 5 || conhostStarts30s >= 20) warnings.push("windows_process_churn_elevated")

const perKeyCrash = evidence.per_key_composer_crash_observed === true
const crashReason = text(evidence.crash_reason).toLowerCase()
const crashThread = text(evidence.crash_thread).toLowerCase()
const crashModule = text(evidence.crash_module).toLowerCase()
const crashEvidencePreserved = evidence.crash_evidence_preserved === true
const desktopComposerIsolated = evidence.desktop_composer_input_isolated === true
const batchPasteCanaryPassed = evidence.batch_paste_canary_passed === true
const automaticRelaunchAttempted = evidence.automatic_relaunch_attempted === true
const composerCrashIncident =
  windows &&
  perKeyCrash &&
  crashReason.includes("exception_breakpoint") &&
  crashThread.includes("crbrowsermain") &&
  crashModule.includes("chrome.dll")

if (automaticRelaunchAttempted && composerCrashIncident) blocked.push("automatic_desktop_relaunch_forbidden")
if (composerCrashIncident && !crashEvidencePreserved) blocked.push("crash_evidence_must_be_preserved")
if (composerCrashIncident && !canonicalStateReconciled) blocked.push("composer_task_state_must_be_reconciled")
if (composerCrashIncident && !externalWritesReconciled) blocked.push("composer_external_writes_must_be_reconciled")
if (composerCrashIncident && !desktopComposerIsolated) remediation.push("isolate_per_key_windows_desktop_composer_input")
if (composerCrashIncident && !batchPasteCanaryPassed) warnings.push("batch_input_workaround_not_verified")
if (composerCrashIncident && rerouteTarget === "none") remediation.push("select_approved_web_cli_or_linux_control_route")

const wslProject = evidence.wsl_project === true
const prTabError = text(evidence.pull_requests_tab_error)
const ghPrListVerified = evidence.gh_pr_list_verified === true
const githubConnectorReadbackVerified = evidence.github_connector_readback_verified === true
const desktopPrTabIsolated = evidence.desktop_pr_tab_isolated === true
const prMutationRequested = evidence.pr_mutation_requested === true
const prMutationIdempotencyVerified = evidence.pr_mutation_idempotency_verified === true
const prPostWriteReadbackVerified = evidence.pr_post_write_readback_verified === true
const wslPrIncident = windows && wslProject && /expected var_sign.*actual: colon/i.test(prTabError)

if (wslPrIncident && !desktopPrTabIsolated) remediation.push("isolate_broken_windows_wsl_pull_requests_tab")
if (wslPrIncident && !ghPrListVerified && !githubConnectorReadbackVerified) {
  blocked.push("authoritative_pull_request_readback_required")
}
if (wslPrIncident && prMutationRequested && !prMutationIdempotencyVerified) blocked.push("pr_mutation_idempotency_required")
if (wslPrIncident && prMutationRequested && !prPostWriteReadbackVerified) blocked.push("pr_post_write_readback_required")

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
  desktop_release: desktopRelease || null,
  store_package: storePackage || null,
  codex_cli_version: cliVersion || null,
  process_discovery_incident: processDiscoveryIncident,
  composer_crash_incident: composerCrashIncident,
  wsl_pr_tab_incident: wslPrIncident,
  reroute_target: rerouteTarget,
  continuity_route:
    status === "compatible"
      ? "continue through pinned direct OpenAI, the verified web control plane, direct GitHub connector, or an explicitly authorized local/Linux route while Windows Desktop remains an audit surface only where isolated"
      : "preserve task, crash, process, repository, and external-write receipts; isolate only the affected Windows Desktop surface; continue the exact unfinished action through an approved web, GitHub, local, or Linux route without replay",
  resume_condition:
    "Restore affected Windows Desktop authority only after a corrected stable build passes repeated idle, active-turn, per-key composer, WMI/process-churn, WSL pull-request listing, mutation readback, and no-duplicate-write canaries.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex Windows control-surface boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
