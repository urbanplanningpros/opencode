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
const approvedReroutes = new Set([
  "none",
  "direct_remote_codex_cli",
  "direct_openai_api",
  "direct_github_connector",
  "approved_linux_vps",
  "authorized_local_linux",
])

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-vscode-reconnect-state-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read VS Code reconnect evidence: ${error.message}`)
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
if (!approvedReroutes.has(rerouteTarget)) blocked.push("unapproved_reroute_target")

const taskId = text(evidence.task_id)
const threadId = text(evidence.thread_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const remotePlatform = text(evidence.remote_platform).toLowerCase()
const extensionVersion = text(evidence.ide_extension_version)
const vscodeVersion = text(evidence.vscode_version)
const workspacePath = text(evidence.workspace_path)
const permissionScopeSha256 = text(evidence.permission_scope_sha256).toLowerCase()

if (!taskId) blocked.push("task_id_missing")
if (!threadId) blocked.push("thread_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")
if (!remotePlatform) blocked.push("remote_platform_missing")
if (!workspacePath) blocked.push("workspace_path_missing")
if (!/^[a-f0-9]{64}$/.test(permissionScopeSha256)) blocked.push("permission_scope_sha256_invalid")

const reconnected = evidence.remote_connection_reconnected === true
const prePermission = text(evidence.pre_disconnect_permission_profile).toLowerCase()
const visiblePermission = text(evidence.post_reconnect_visible_permission_profile).toLowerCase()
const runtimePermission = text(evidence.post_reconnect_runtime_permission_profile).toLowerCase()
const repeatedPrompts = evidence.repeated_approval_prompts_after_reconnect === true
const chatStateRehydrated = evidence.chat_state_rehydrated === true
const messageReadbackPassed = evidence.submitted_message_readback_passed === true
const scrollStable = evidence.chat_scroll_state_stable === true
const canonicalThreadPreserved = evidence.canonical_thread_preserved === true
const permissionReceiptPreserved = evidence.permission_receipt_preserved === true
const canonicalStateReconciled = evidence.canonical_task_state_reconciled === true
const repositoryStateReconciled = evidence.repository_state_reconciled === true
const externalWritesReconciled = evidence.external_writes_reconciled === true
const explicitReauthorization = evidence.explicit_reauthorization_received === true
const mutationAuthorityRequested = evidence.mutation_authority_requested === true
const automaticReplayRequested = evidence.automatic_task_replay_requested === true
const replacementGoalCreated = evidence.replacement_goal_created_before_reconciliation === true
const freshGoalCanaryPassed = evidence.fresh_goal_permission_canary_passed === true

const windowsRemoteLinux = platform.includes("windows") && remotePlatform.includes("linux")
const permissionMismatch = prePermission && runtimePermission && prePermission !== runtimePermission
const visibleRuntimeMismatch = visiblePermission && runtimePermission && visiblePermission !== runtimePermission
const reconnectIncident =
  windowsRemoteLinux &&
  reconnected &&
  (permissionMismatch || visibleRuntimeMismatch || repeatedPrompts || !chatStateRehydrated || !messageReadbackPassed)

if (automaticReplayRequested && reconnectIncident) blocked.push("automatic_task_replay_forbidden")
if (replacementGoalCreated && reconnectIncident) blocked.push("replacement_goal_before_reconciliation_forbidden")
if (reconnectIncident && !canonicalThreadPreserved) blocked.push("canonical_thread_must_be_preserved")
if (reconnectIncident && !canonicalStateReconciled) blocked.push("canonical_task_state_must_be_reconciled")
if (reconnectIncident && !repositoryStateReconciled) blocked.push("repository_state_must_be_reconciled")
if (reconnectIncident && !externalWritesReconciled) blocked.push("external_writes_must_be_reconciled")
if (reconnectIncident && mutationAuthorityRequested && permissionMismatch && !explicitReauthorization) {
  blocked.push("mutation_authority_requires_explicit_reauthorization")
}

if (reconnectIncident && !permissionReceiptPreserved) remediation.push("preserve_pre_disconnect_permission_receipt")
if (reconnectIncident && !chatStateRehydrated) remediation.push("rehydrate_chat_from_canonical_thread")
if (reconnectIncident && !messageReadbackPassed) remediation.push("verify_submitted_message_readback")
if (reconnectIncident && permissionMismatch && !explicitReauthorization) remediation.push("request_one_explicit_permission_reauthorization")
if (reconnectIncident && visibleRuntimeMismatch) remediation.push("resynchronize_visible_and_runtime_permission_state")
if (reconnectIncident && !freshGoalCanaryPassed && rerouteTarget === "none") {
  remediation.push("continue_exact_unfinished_action_through_direct_or_approved_local_route")
}
if (reconnectIncident && !scrollStable) warnings.push("chat_scroll_state_not_stable")
if (repeatedPrompts) warnings.push("permission_profile_not_restored_after_reconnect")

const recoveryComplete =
  reconnectIncident &&
  canonicalThreadPreserved &&
  permissionReceiptPreserved &&
  canonicalStateReconciled &&
  repositoryStateReconciled &&
  externalWritesReconciled &&
  chatStateRehydrated &&
  messageReadbackPassed &&
  (runtimePermission === prePermission || explicitReauthorization) &&
  freshGoalCanaryPassed

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: new Date().toISOString(),
  status,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  task_id: taskId || null,
  thread_id: threadId || null,
  operation_id: operationId || null,
  platform: platform || null,
  remote_platform: remotePlatform || null,
  ide_extension_version: extensionVersion || null,
  vscode_version: vscodeVersion || null,
  workspace_path: workspacePath || null,
  reconnect_incident: reconnectIncident,
  permission_mismatch: permissionMismatch,
  visible_runtime_permission_mismatch: visibleRuntimeMismatch,
  recovery_complete: recoveryComplete,
  reroute_target: rerouteTarget,
  continuity_route:
    status === "compatible"
      ? "continue the existing canonical thread after permission and chat-state readback canaries, or continue the exact unfinished action through direct remote Codex CLI, direct OpenAI API, direct GitHub connector, or an explicitly authorized local/Linux route"
      : "preserve the canonical thread and pre-disconnect permission receipt; reconcile task, repository, and external writes; require one explicit reauthorization before mutation; rehydrate chat state or continue the exact unfinished action through an approved direct or local route without replay or replacement",
  resume_condition:
    "Restore ordinary mutation authority in the resumed VS Code Goal only after the canonical thread and permission receipt are preserved, repository and external writes are reconciled, visible and runtime permission state agree or one explicit reauthorization is recorded, submitted-message readback succeeds, and a disposable permission canary passes.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex VS Code reconnect state boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
