#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delegated-compaction-"))
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-delegated-compaction-continuity-guard.mjs")

function run(name, evidence, expectedExit, expectedStatus) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedExit) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${name}: expected exit ${expectedExit}, got ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedStatus) throw new Error(`${name}: expected ${expectedStatus}, got ${output.status}`)
  return output
}

const base = {
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  thread: {
    thread_id: "thread-123",
    compaction_mode: "remote_v2",
    canonical_thread_preserved: true,
    external_write_state_reconciled: true,
    automatic_respawn_attempted: false,
    automatic_replay_attempted: false,
  },
  delegated_tasks: [
    {
      task_id: "agent-task-active",
      parent_agent_message_id: "agent-message-1",
      content_hash: "a".repeat(64),
      encrypted_content: true,
      token_estimate_included: true,
      status: "running",
      completion_message: false,
      retained_in_followup: true,
      restored_before_latest_real_message: true,
    },
    {
      task_id: "agent-task-complete",
      parent_agent_message_id: "agent-message-2",
      content_hash: "b".repeat(64),
      encrypted_content: false,
      token_estimate_included: true,
      status: "completed",
      completion_message: true,
      retained_in_followup: false,
      restored_before_latest_real_message: false,
    },
  ],
  history: {
    initial_context_restored_before_latest_real_message: true,
    encrypted_agent_content_accounted_for: true,
    pre_compaction_hash: "c".repeat(64),
    post_compaction_hash: "d".repeat(64),
    retained_message_count: 24,
    retention_limit: 32,
  },
  child_fork: {
    created: true,
    child_thread_id: "thread-child",
    source_thread_id: "thread-123",
    inherited_parent_agent_messages_stripped: true,
    child_completion_messages_retained: false,
  },
  continuation: {
    route: "same_thread",
    exact_unfinished_action_only: true,
    state_checkpoint_preserved: true,
  },
}

try {
  run("healthy", base, 0, "compatible")

  const missingActive = structuredClone(base)
  missingActive.delegated_tasks[0].retained_in_followup = false
  const missingResult = run("missing-active", missingActive, 64, "blocked")
  if (!missingResult.blocked.includes("active_delegated_task_missing_after_compaction:agent-task-active")) {
    throw new Error("missing-active: active delegated task loss not blocked")
  }

  const retainedCompletion = structuredClone(base)
  retainedCompletion.delegated_tasks[1].retained_in_followup = true
  const completionResult = run("retained-completion", retainedCompletion, 64, "blocked")
  if (!completionResult.blocked.includes("delegated_completion_message_retained_after_compaction:agent-task-complete")) {
    throw new Error("retained-completion: completion replay context not blocked")
  }

  const encryptedOmitted = structuredClone(base)
  encryptedOmitted.delegated_tasks[0].token_estimate_included = false
  encryptedOmitted.history.encrypted_agent_content_accounted_for = false
  const encryptedResult = run("encrypted-omitted", encryptedOmitted, 64, "blocked")
  if (!encryptedResult.blocked.includes("encrypted_delegated_content_omitted_from_token_estimate:agent-task-active")) {
    throw new Error("encrypted-omitted: encrypted content estimate omission not blocked")
  }

  const wrongOrder = structuredClone(base)
  wrongOrder.history.initial_context_restored_before_latest_real_message = false
  wrongOrder.delegated_tasks[0].restored_before_latest_real_message = false
  run("wrong-order", wrongOrder, 64, "blocked")

  const contaminatedFork = structuredClone(base)
  contaminatedFork.child_fork.inherited_parent_agent_messages_stripped = false
  const forkResult = run("contaminated-fork", contaminatedFork, 64, "blocked")
  if (!forkResult.blocked.includes("child_fork_inherited_parent_agent_messages")) {
    throw new Error("contaminated-fork: inherited parent messages not blocked")
  }

  const replay = structuredClone(base)
  replay.thread.automatic_respawn_attempted = true
  replay.thread.automatic_replay_attempted = true
  run("unsafe-replay", replay, 64, "blocked")

  const prohibited = structuredClone(base)
  prohibited.routing = { provider: "claude", route: "gateway", automatic_selector: true, model_gateway: true }
  run("prohibited", prohibited, 64, "blocked")

  console.log("Codex delegated-compaction continuity guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
