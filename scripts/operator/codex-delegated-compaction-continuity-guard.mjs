#!/usr/bin/env node
import fs from "node:fs"

function parseArgs(values) {
  const args = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = values[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

const prohibited = [
  "anthropic",
  "claude",
  "manus",
  "openrouter",
  "litellm",
  "bedrock",
  "vertex",
  "copilot-auto",
  "model-gateway",
]

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-delegated-compaction-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  evidence = JSON.parse(fs.readFileSync(args.input, "utf8"))
} catch (error) {
  console.error(`Unable to read delegated-compaction evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const routeReceipt = `${provider} ${route}`
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.some((name) => routeReceipt.includes(name))) blocked.push("prohibited_provider_or_gateway")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const thread = evidence.thread || {}
if (!text(thread.thread_id)) blocked.push("thread_id_missing")
if (text(thread.compaction_mode).toLowerCase() !== "remote_v2") warnings.push("guard_applied_outside_remote_v2_compaction")
if (thread.canonical_thread_preserved !== true) blocked.push("canonical_thread_not_preserved")
if (thread.external_write_state_reconciled !== true) blocked.push("external_write_state_not_reconciled")
if (thread.automatic_respawn_attempted === true) blocked.push("automatic_delegated_task_respawn_forbidden")
if (thread.automatic_replay_attempted === true) blocked.push("automatic_mutation_replay_forbidden")

const tasks = Array.isArray(evidence.delegated_tasks) ? evidence.delegated_tasks : []
if (tasks.length === 0) blocked.push("delegated_task_receipts_missing")
for (const task of tasks) {
  const taskId = text(task.task_id) || "unknown"
  const status = text(task.status).toLowerCase()
  const isCompletion = task.completion_message === true || ["completed", "failed", "cancelled"].includes(status)
  if (!text(task.parent_agent_message_id)) blocked.push(`delegated_task_parent_message_missing:${taskId}`)
  if (!text(task.content_hash)) blocked.push(`delegated_task_content_hash_missing:${taskId}`)
  if (task.encrypted_content === true && task.token_estimate_included !== true) {
    blocked.push(`encrypted_delegated_content_omitted_from_token_estimate:${taskId}`)
  }
  if (!isCompletion && task.retained_in_followup !== true) {
    blocked.push(`active_delegated_task_missing_after_compaction:${taskId}`)
  }
  if (isCompletion && task.retained_in_followup === true) {
    blocked.push(`delegated_completion_message_retained_after_compaction:${taskId}`)
  }
  if (!isCompletion && task.restored_before_latest_real_message !== true) {
    blocked.push(`delegated_task_restored_after_latest_real_message:${taskId}`)
  }
}

const history = evidence.history || {}
if (history.initial_context_restored_before_latest_real_message !== true) {
  blocked.push("initial_context_order_invalid_after_compaction")
}
if (history.encrypted_agent_content_accounted_for !== true) {
  blocked.push("encrypted_agent_content_missing_from_history_estimate")
}
if (!text(history.pre_compaction_hash) || !text(history.post_compaction_hash)) {
  blocked.push("compaction_history_hash_receipts_missing")
}
if (Number(history.retained_message_count || 0) > Number(history.retention_limit || 0) && Number(history.retention_limit || 0) > 0) {
  blocked.push("compaction_retention_limit_exceeded")
}

const fork = evidence.child_fork || {}
if (fork.created === true) {
  if (!text(fork.child_thread_id)) blocked.push("child_thread_id_missing")
  if (fork.inherited_parent_agent_messages_stripped !== true) blocked.push("child_fork_inherited_parent_agent_messages")
  if (fork.child_completion_messages_retained === true) blocked.push("child_fork_retained_completion_messages")
  if (fork.source_thread_id !== thread.thread_id) blocked.push("child_fork_source_thread_mismatch")
}

const continuation = evidence.continuation || {}
const allowedRoutes = new Set(["same_thread", "guarded_single_agent", "approved_local", "approved_linux"])
const continuationRoute = text(continuation.route).toLowerCase()
if (!allowedRoutes.has(continuationRoute)) blocked.push("approved_continuation_route_missing")
if (continuation.exact_unfinished_action_only !== true) blocked.push("continuation_not_limited_to_exact_unfinished_action")
if (continuation.state_checkpoint_preserved !== true) blocked.push("state_checkpoint_not_preserved")

if (blocked.length > 0) {
  remediation.push("preserve_the_canonical_thread_and_compaction_rollout")
  remediation.push("restore_active_delegated_agent_messages_before_the_latest_real_message")
  remediation.push("exclude_child_completion_messages_and_strip_parent_agent_messages_from_child_forks")
  remediation.push("reconcile_external_writes_before_any_retry_or_respawn")
  remediation.push("continue_only_the_exact_unfinished_action_through_same_thread_or_an_approved_local_linux_route")
}

const unique = (values) => [...new Set(values)]
const result = {
  status: blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible",
  blocked: unique(blocked),
  remediation: unique(remediation),
  warnings: unique(warnings),
  upstream_baseline: "openai/codex#36128",
}

if (args.json) console.log(JSON.stringify(result, null, 2))
else console.log(`${result.status}: ${[...result.blocked, ...result.remediation].join(", ") || "verified"}`)
process.exit(result.status === "compatible" ? 0 : result.status === "remediation_required" ? 75 : 64)
