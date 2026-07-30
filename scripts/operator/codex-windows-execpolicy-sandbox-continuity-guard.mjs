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

function canonicalWindowsPath(value) {
  const raw = text(value)
  if (!raw) return ""
  return path.win32.normalize(raw).replace(/[\\/]+$/, "").toLowerCase()
}

function isWithinWindowsPath(candidate, root) {
  const normalizedCandidate = canonicalWindowsPath(candidate)
  const normalizedRoot = canonicalWindowsPath(root)
  if (!normalizedCandidate || !normalizedRoot) return false
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
}

const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-windows-execpolicy-sandbox-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read Windows execpolicy/sandbox evidence: ${error.message}`)
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
if (!new Set(["none", "absolute_bound_windows_launcher", "approved_linux_vps", "authorized_local_linux", "approved_host_verifier"]).has(rerouteTarget)) {
  blocked.push("unapproved_reroute_target")
}

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const shell = text(evidence.shell).toLowerCase()
const cliVersion = text(evidence.codex_cli_version)
if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")

const windowsPowerShell = platform.includes("windows") && shell.includes("powershell")

// Boundary 1: durable execpolicy authority for a bare PowerShell command must be
// bound to the exact launcher that is checked and executed.
const durableAllowRequested = evidence.durable_allow_requested === true
const bareCommandInvocation = evidence.bare_command_invocation === true
const logicalCommand = text(evidence.logical_command)
const resolvedLauncherPath = text(evidence.resolved_launcher_path)
const resolvedLauncherSha256 = text(evidence.resolved_launcher_sha256).toLowerCase()
const launcherKind = text(evidence.launcher_kind).toLowerCase()
const supportedLauncherKind = new Set(["exe", "com", "cmd", "bat", "ps1"]).has(launcherKind)
const exactTargetSelectedBeforeApproval = evidence.exact_target_selected_before_approval === true
const policyCheckedLogicalName = evidence.policy_checked_logical_name === true
const policyCheckedBoundPath = evidence.policy_checked_bound_path === true
const strictestDecisionPreserved = evidence.strictest_decision_preserved === true
const executionUsesBoundTarget = evidence.execution_uses_bound_target === true
const secondNameLookupPossible = evidence.second_name_lookup_possible === true
const resolverAmbiguous = evidence.resolver_ambiguous === true
const compoundOrPipelineCommand = evidence.compound_or_pipeline_command === true
const targetRegularFile = evidence.resolved_target_regular_file === true
const targetSymlink = evidence.resolved_target_symlink === true
const launcherHashVerified = /^[a-f0-9]{64}$/.test(resolvedLauncherSha256) && evidence.launcher_hash_verified === true

const bareAllowIncident = windowsPowerShell && durableAllowRequested && bareCommandInvocation
if (bareAllowIncident && !logicalCommand) blocked.push("logical_command_missing")
if (bareAllowIncident && !resolvedLauncherPath) blocked.push("resolved_launcher_path_required")
if (bareAllowIncident && !supportedLauncherKind) blocked.push("supported_launcher_kind_required")
if (bareAllowIncident && !targetRegularFile) blocked.push("resolved_launcher_must_be_regular_file")
if (bareAllowIncident && targetSymlink) blocked.push("resolved_launcher_symlink_forbidden")
if (bareAllowIncident && !launcherHashVerified) blocked.push("resolved_launcher_hash_receipt_required")
if (bareAllowIncident && !exactTargetSelectedBeforeApproval) blocked.push("target_must_be_selected_before_approval")
if (bareAllowIncident && !policyCheckedLogicalName) blocked.push("logical_name_policy_check_required")
if (bareAllowIncident && !policyCheckedBoundPath) blocked.push("bound_path_policy_check_required")
if (bareAllowIncident && !strictestDecisionPreserved) blocked.push("strictest_policy_decision_must_win")
if (bareAllowIncident && !executionUsesBoundTarget) blocked.push("executor_must_use_bound_target")
if (bareAllowIncident && secondNameLookupPossible) blocked.push("second_name_lookup_forbidden")
if (bareAllowIncident && resolverAmbiguous) blocked.push("ambiguous_command_resolution_forbidden")
if (bareAllowIncident && compoundOrPipelineCommand) blocked.push("compound_bare_allow_forbidden")
if (bareAllowIncident && blocked.length === 0 && rerouteTarget === "none") {
  warnings.push("bound_launcher_route_not_declared")
}
if (bareAllowIncident && blocked.length > 0) {
  remediation.push("withhold_only_durable_bare_command_allow")
  remediation.push("invoke_exact_verified_launcher_path_or_keep_command_approval_gated")
}

// Boundary 2: a Windows sandbox read-after-create failure must never silently
// become a broad unsandboxed retry. Preserve state and use a constrained route.
const sandboxMode = text(evidence.windows_sandbox_mode).toLowerCase()
const sandboxHealthcheckPath = text(evidence.sandbox_healthcheck_path)
const workspaceRoot = text(evidence.workspace_root)
const createSucceeded = evidence.sandbox_create_succeeded === true
const readFailed = evidence.sandbox_read_failed === true
const sandboxErrorCode = text(evidence.sandbox_error_code).toUpperCase()
const retryWithoutSandboxRequested = evidence.retry_without_sandbox_requested === true
const automaticUnsandboxedRetryAttempted = evidence.automatic_unsandboxed_retry_attempted === true
const healthcheckPathWithinWorkspace = evidence.healthcheck_path_within_workspace === true && isWithinWindowsPath(sandboxHealthcheckPath, workspaceRoot)
const healthcheckRegularFile = evidence.healthcheck_regular_file === true
const healthcheckSymlink = evidence.healthcheck_symlink === true
const canonicalStateReconciled = evidence.canonical_task_state_reconciled === true
const externalWritesReconciled = evidence.external_writes_reconciled === true
const sandboxReceiptPreserved = evidence.sandbox_failure_receipt_preserved === true
const exactFallbackOperation = evidence.exact_fallback_operation_bound === true
const fallbackMutationClass = text(evidence.fallback_mutation_class).toLowerCase()
const readOnlyFallback = fallbackMutationClass === "read_only"
const mutatingFallback = new Set(["write", "update", "delete"]).has(fallbackMutationClass)
const hostVerifierHash = text(evidence.approved_host_verifier_sha256).toLowerCase()
const hostVerifierVerified = /^[a-f0-9]{64}$/.test(hostVerifierHash) && evidence.approved_host_verifier_verified === true
const postFallbackReadback = evidence.post_fallback_readback_verified === true
const noDuplicateMutation = evidence.no_duplicate_mutation_verified === true

const sandboxReadAfterCreateIncident =
  windowsPowerShell &&
  ["elevated", "unelevated", "native"].includes(sandboxMode) &&
  createSucceeded &&
  readFailed &&
  sandboxErrorCode.includes("PATCH_SERVICE_UNAVAILABLE")

if (sandboxReadAfterCreateIncident && automaticUnsandboxedRetryAttempted) blocked.push("automatic_unsandboxed_retry_forbidden")
if (sandboxReadAfterCreateIncident && !sandboxHealthcheckPath) blocked.push("sandbox_healthcheck_path_required")
if (sandboxReadAfterCreateIncident && !workspaceRoot) blocked.push("workspace_root_required")
if (sandboxReadAfterCreateIncident && !healthcheckPathWithinWorkspace) blocked.push("healthcheck_path_must_be_canonical_and_within_workspace")
if (sandboxReadAfterCreateIncident && !healthcheckRegularFile) blocked.push("healthcheck_target_must_be_regular_file")
if (sandboxReadAfterCreateIncident && healthcheckSymlink) blocked.push("healthcheck_symlink_forbidden")
if (sandboxReadAfterCreateIncident && !sandboxReceiptPreserved) blocked.push("sandbox_failure_receipt_must_be_preserved")
if (sandboxReadAfterCreateIncident && !canonicalStateReconciled) blocked.push("canonical_task_state_must_be_reconciled")
if (sandboxReadAfterCreateIncident && !externalWritesReconciled) blocked.push("external_writes_must_be_reconciled")
if (sandboxReadAfterCreateIncident && retryWithoutSandboxRequested && !exactFallbackOperation) blocked.push("exact_fallback_operation_binding_required")
if (sandboxReadAfterCreateIncident && retryWithoutSandboxRequested && rerouteTarget === "approved_host_verifier" && !readOnlyFallback) {
  blocked.push("approved_host_verifier_must_be_read_only")
}
if (sandboxReadAfterCreateIncident && retryWithoutSandboxRequested && rerouteTarget === "approved_host_verifier" && !hostVerifierVerified) {
  blocked.push("approved_host_verifier_hash_receipt_required")
}
if (sandboxReadAfterCreateIncident && mutatingFallback && !noDuplicateMutation) blocked.push("duplicate_mutation_reconciliation_required")
if (sandboxReadAfterCreateIncident && mutatingFallback && !postFallbackReadback) blocked.push("mutating_fallback_post_write_readback_required")
if (sandboxReadAfterCreateIncident && rerouteTarget === "none") {
  remediation.push("isolate_only_affected_windows_sandbox_helper")
  remediation.push("select_approved_read_verifier_or_local_linux_execution_route")
}
if (sandboxReadAfterCreateIncident && retryWithoutSandboxRequested && readOnlyFallback && rerouteTarget === "approved_host_verifier" && hostVerifierVerified) {
  warnings.push("one_time_read_only_host_verifier_in_use")
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
  bare_execpolicy_binding_incident: bareAllowIncident,
  sandbox_read_after_create_incident: sandboxReadAfterCreateIncident,
  reroute_target: rerouteTarget,
  continuity_route:
    status === "compatible"
      ? "continue through the exact checksum-bound Windows launcher, a one-time approved read-only host verifier, or an explicitly authorized local/Linux route"
      : "preserve task, approval, launcher, sandbox, repository, and external-write receipts; isolate only the unsafe durable allow or failed sandbox helper; continue the exact unfinished action without replay",
  resume_condition:
    "Restore durable bare-command authority only after policy evaluation and execution share one exact verified launcher target with no second name lookup. Restore the affected Windows sandbox helper only after create-read-update-read-delete canaries pass without an unsandboxed retry prompt.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex Windows execpolicy/sandbox boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
