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
  console.error("Usage: node scripts/operator/codex-windows-remote-ssh-hydration-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read Remote SSH hydration evidence: ${error.message}`)
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
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const remotePlatform = text(evidence.remote_platform).toLowerCase()
const desktopRelease = text(evidence.desktop_release)
const cliVersion = text(evidence.codex_cli_version)
if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")
if (!remotePlatform) blocked.push("remote_platform_missing")

const concurrentResumeCount = number(evidence.concurrent_thread_resume_count)
const inFlightCount = number(evidence.app_server_in_flight_request_count)
const queueWaitMs = number(evidence.maximum_queue_wait_ms)
const slowestResumeMs = number(evidence.slowest_thread_resume_ms)
const monolithicRecordBytes = number(evidence.maximum_jsonl_record_bytes)
const daemonRestartCount = number(evidence.managed_remote_daemon_restart_count)
const postRecoveryTurnStartMs = number(evidence.post_recovery_turn_start_ms)
for (const [name, value] of Object.entries({
  concurrentResumeCount,
  inFlightCount,
  queueWaitMs,
  slowestResumeMs,
  monolithicRecordBytes,
  daemonRestartCount,
  postRecoveryTurnStartMs,
})) {
  if (Number.isNaN(value)) blocked.push(`${name}_invalid`)
}

const remoteSshEnabled = evidence.remote_ssh_enabled === true
const autoConnectEnabled = evidence.remote_ssh_auto_connect_enabled === true
const websocketCloseCode = text(evidence.websocket_close_code)
const daemonAlive = evidence.managed_remote_daemon_alive === true
const sshTransportStable = evidence.normal_ssh_transport_stable === true
const serverCpuSaturated = evidence.server_cpu_saturated === true
const serverMemorySaturated = evidence.server_memory_saturated === true
const queueExpired = evidence.app_server_queue_expired === true || queueWaitMs >= 30000

const windowsRemoteLinux = platform.includes("windows") && remotePlatform.includes("linux")
const hydrationIncident =
  windowsRemoteLinux &&
  remoteSshEnabled &&
  autoConnectEnabled &&
  concurrentResumeCount >= 2 &&
  inFlightCount >= 6 &&
  queueExpired &&
  slowestResumeMs >= 50000 &&
  websocketCloseCode === "1006" &&
  daemonAlive &&
  sshTransportStable &&
  !serverCpuSaturated &&
  !serverMemorySaturated

if (monolithicRecordBytes >= 1024 * 1024) warnings.push("monolithic_session_record_detected")

const threadInventoryPreserved = evidence.thread_inventory_preserved === true
const offendingThreadIds = Array.isArray(evidence.offending_thread_ids)
  ? evidence.offending_thread_ids.map(text).filter(Boolean)
  : []
const offendingThreadsArchived = evidence.offending_threads_archived === true
const pendingResumeCancelled = evidence.pending_resume_operations_cancelled === true
const hydrationQueueCleared = evidence.hydration_queue_cleared === true
const automaticReconnectStopped = evidence.automatic_reconnect_stopped === true
const canonicalStateReconciled = evidence.canonical_task_state_reconciled === true
const externalWritesReconciled = evidence.external_writes_reconciled === true
const daemonRestartAfterQueueClear = evidence.daemon_restart_after_queue_clear === true
const connectionCanaryPassed = evidence.post_recovery_connection_canary_passed === true
const interactivePriorityVerified = evidence.interactive_request_priority_verified === true
const automaticReplayRequested = evidence.automatic_task_replay_requested === true
const replacementThreadCreated = evidence.replacement_thread_created_before_reconciliation === true
const destructiveThreadDeletion = evidence.offending_threads_deleted === true

if (destructiveThreadDeletion) blocked.push("destructive_thread_deletion_forbidden")
if (automaticReplayRequested && hydrationIncident) blocked.push("automatic_task_replay_forbidden")
if (replacementThreadCreated && hydrationIncident) blocked.push("replacement_thread_before_reconciliation_forbidden")
if (daemonRestartCount > 1) blocked.push("repeated_remote_daemon_restart_forbidden")
if (daemonRestartCount === 1 && !daemonRestartAfterQueueClear) blocked.push("remote_daemon_restart_must_follow_queue_clear")

if (hydrationIncident && !threadInventoryPreserved) blocked.push("thread_inventory_must_be_preserved")
if (hydrationIncident && offendingThreadIds.length === 0) blocked.push("offending_thread_identity_required")
if (hydrationIncident && !canonicalStateReconciled) blocked.push("canonical_task_state_must_be_reconciled")
if (hydrationIncident && !externalWritesReconciled) blocked.push("external_writes_must_be_reconciled")
if (hydrationIncident && !offendingThreadsArchived) remediation.push("archive_offending_threads_reversibly")
if (hydrationIncident && !pendingResumeCancelled) remediation.push("cancel_pending_thread_resume_operations")
if (hydrationIncident && !hydrationQueueCleared) remediation.push("clear_remote_hydration_queue")
if (hydrationIncident && !automaticReconnectStopped) remediation.push("stop_automatic_remote_reconnect")
if (hydrationIncident && daemonRestartCount === 0) remediation.push("restart_managed_remote_daemon_once_after_queue_clear")
if (hydrationIncident && !connectionCanaryPassed && rerouteTarget === "none") {
  remediation.push("use_direct_remote_cli_or_approved_local_linux_route")
}
if (hydrationIncident && connectionCanaryPassed && postRecoveryTurnStartMs > 1000) {
  warnings.push("post_recovery_interactive_latency_elevated")
}
if (hydrationIncident && !interactivePriorityVerified) warnings.push("interactive_request_priority_not_verified")

const recoveryComplete =
  hydrationIncident &&
  threadInventoryPreserved &&
  offendingThreadIds.length > 0 &&
  offendingThreadsArchived &&
  pendingResumeCancelled &&
  hydrationQueueCleared &&
  automaticReconnectStopped &&
  daemonRestartCount === 1 &&
  daemonRestartAfterQueueClear &&
  canonicalStateReconciled &&
  externalWritesReconciled &&
  connectionCanaryPassed &&
  postRecoveryTurnStartMs <= 1000

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
  remote_platform: remotePlatform || null,
  desktop_release: desktopRelease || null,
  codex_cli_version: cliVersion || null,
  hydration_incident: hydrationIncident,
  recovery_complete: recoveryComplete,
  offending_thread_ids: offendingThreadIds,
  reroute_target: rerouteTarget,
  continuity_route:
    status === "compatible"
      ? "continue through the recovered Remote SSH connection after bounded hydration canaries, or bypass Desktop hydration through direct remote Codex CLI, direct OpenAI API, direct GitHub connector, or an explicitly authorized local/Linux route"
      : "preserve task, thread, repository, approval, and external-write receipts; archive only the identified blocking threads; cancel hydration and stop reconnect replay; continue the exact unfinished action through an approved direct or local route without respawn or mutation replay",
  resume_condition:
    "Restore ordinary Remote SSH auto-connect only after the blocking thread identities are preserved and reversibly archived, pending resumes are cancelled, the hydration queue is clear, the managed daemon has been restarted no more than once after queue clear, and repeated thread/start plus turn/start canaries complete without queue saturation, WebSocket 1006 closure, or duplicate writes.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex Windows Remote SSH hydration boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
