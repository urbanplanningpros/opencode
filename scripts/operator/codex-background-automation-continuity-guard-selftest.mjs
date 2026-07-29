import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-background-automation-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-background-automation-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason)
}

const base = {
  task_id: "task-123",
  automation_id: "automation-123",
  automation_type: "cron",
  repository_backed: true,
  writes_repository: true,
  execution_environment: "worktree",
  saved_configuration_read_back: true,
  runtime_worktree_observed: true,
  uncertain_writes_reconciled: true,
  worktree_environment: {
    delegated_or_programmatic_creation: true,
    selected_environment_bound: true,
    setup_script_required: true,
    setup_script_completed: true,
    expected_artifacts_verified: true,
    environment_manager_ready: true,
  },
  scheduled_execution: {
    background_driver_verified: true,
    first_tool_started: true,
    progress_heartbeat_observed: true,
    manual_resume_required: false,
    same_thread_resume_only: true,
  },
  pending_approval: {
    blocking: true,
    event_type: "mcp_resolve_elicitation",
    exact_request_visible: true,
    actionable_notification_observed: false,
    approval_watchdog_active: true,
    request_id: "approval-123",
    operation_id: "operation-123",
    payload_sha256: "a".repeat(64),
    expires_at: "2026-07-29T23:00:00Z",
  },
  remote_connection: {
    used: true,
    endpoint_reachable: true,
    app_reconnected: true,
    task_identity_verified: true,
    state_verified: true,
    sequence_gap_detected: false,
    canonical_host_state: "active",
    canonical_state_reconciled: true,
    controller_projection_resynced: true,
    resume_attempted: false,
  },
  app_server: {
    used: false,
    unexpected_exit: false,
    destroyed_stdin_observed: false,
    extension_host_restarted: false,
    canonical_turn_state_reconciled: false,
    external_command_state_reconciled: false,
    automatic_replay_attempted: false,
    replacement_session_created: false,
  },
  context_handoff: {
    used: false,
    large_context: false,
    direct_work_migration_attempted: false,
    manual_checkpoint_route_used: false,
    source_checkpoint_exported: false,
    source_thread_preserved: false,
    target_thread_created: false,
    target_thread_indexed: false,
    renderer_healthy: false,
    automatic_replay_attempted: false,
  },
}

run("safe", base, 0, "background_automation_continuity_verified")
run(
  "local-write",
  { ...base, execution_environment: "local", runtime_worktree_observed: false },
  75,
  "repository_writing_automation_not_isolated",
)
run(
  "delegated-worktree-environment-uninitialized",
  {
    ...base,
    worktree_environment: {
      ...base.worktree_environment,
      setup_script_completed: false,
      expected_artifacts_verified: false,
      environment_manager_ready: false,
    },
  },
  75,
  "delegated_worktree_environment_uninitialized",
)
run(
  "local-stall",
  {
    ...base,
    repository_backed: false,
    writes_repository: false,
    execution_environment: "local",
    scheduled_execution: {
      ...base.scheduled_execution,
      background_driver_verified: false,
      first_tool_started: false,
      progress_heartbeat_observed: false,
      manual_resume_required: true,
    },
  },
  75,
  "local_scheduled_run_requires_foreground_resume",
)
run(
  "local-stall-unsafe-resume",
  {
    ...base,
    repository_backed: false,
    writes_repository: false,
    execution_environment: "local",
    scheduled_execution: {
      ...base.scheduled_execution,
      background_driver_verified: false,
      first_tool_started: false,
      progress_heartbeat_observed: false,
      manual_resume_required: true,
      same_thread_resume_only: false,
    },
  },
  64,
  "stalled_local_task_must_resume_same_thread",
)
run(
  "local-background-unverified",
  {
    ...base,
    repository_backed: false,
    writes_repository: false,
    execution_environment: "local",
    scheduled_execution: { ...base.scheduled_execution, progress_heartbeat_observed: false },
  },
  75,
  "local_scheduled_background_execution_unverified",
)
run(
  "hidden-approval",
  { ...base, pending_approval: { ...base.pending_approval, exact_request_visible: false } },
  64,
  "approval_request_not_visible",
)
run(
  "no-attention",
  {
    ...base,
    pending_approval: {
      ...base.pending_approval,
      actionable_notification_observed: false,
      approval_watchdog_active: false,
    },
  },
  75,
  "blocking_approval_has_no_actionable_attention_route",
)
run(
  "remote-unverified",
  { ...base, remote_connection: { ...base.remote_connection, app_reconnected: false } },
  75,
  "remote_connection_restored_but_codex_state_unverified",
)
run(
  "remote-sequence-gap-unreconciled",
  {
    ...base,
    remote_connection: {
      ...base.remote_connection,
      sequence_gap_detected: true,
      canonical_host_state: "completed",
      canonical_state_reconciled: false,
      controller_projection_resynced: false,
    },
  },
  75,
  "remote_sequence_gap_not_reconciled",
)
run(
  "remote-sequence-gap-stale-projection",
  {
    ...base,
    remote_connection: {
      ...base.remote_connection,
      sequence_gap_detected: true,
      canonical_host_state: "completed",
      canonical_state_reconciled: true,
      controller_projection_resynced: false,
    },
  },
  75,
  "remote_controller_projection_stale",
)
run(
  "remote-completed-replay",
  {
    ...base,
    remote_connection: {
      ...base.remote_connection,
      sequence_gap_detected: true,
      canonical_host_state: "completed",
      canonical_state_reconciled: true,
      controller_projection_resynced: false,
      resume_attempted: true,
    },
  },
  64,
  "completed_remote_task_resume_forbidden",
)
run(
  "app-server-sigill-unreconciled",
  {
    ...base,
    app_server: {
      ...base.app_server,
      used: true,
      unexpected_exit: true,
      unexpected_exit_signal: "SIGILL",
      destroyed_stdin_observed: true,
      continuation_route: "approved_linux",
    },
  },
  75,
  "app_server_failure_state_unreconciled",
)
run(
  "app-server-sigill-approved-linux-recovery",
  {
    ...base,
    app_server: {
      ...base.app_server,
      used: true,
      unexpected_exit: true,
      unexpected_exit_signal: "SIGILL",
      destroyed_stdin_observed: true,
      canonical_turn_state_reconciled: true,
      external_command_state_reconciled: true,
      continuation_route: "approved_linux",
    },
  },
  0,
  "background_automation_continuity_verified",
)
run(
  "app-server-failure-auto-replay",
  {
    ...base,
    app_server: {
      ...base.app_server,
      used: true,
      unexpected_exit: true,
      unexpected_exit_signal: "SIGILL",
      destroyed_stdin_observed: true,
      canonical_turn_state_reconciled: true,
      external_command_state_reconciled: true,
      automatic_replay_attempted: true,
      continuation_route: "approved_linux",
    },
  },
  64,
  "app_server_failure_replay_forbidden",
)
run(
  "large-context-direct-work-handoff",
  {
    ...base,
    context_handoff: {
      ...base.context_handoff,
      used: true,
      large_context: true,
      direct_work_migration_attempted: true,
    },
  },
  75,
  "large_context_direct_work_handoff_untrusted",
)
run(
  "large-context-checkpoint-incomplete",
  {
    ...base,
    context_handoff: {
      ...base.context_handoff,
      used: true,
      large_context: true,
      manual_checkpoint_route_used: true,
      source_checkpoint_exported: true,
      source_thread_preserved: true,
      target_thread_created: true,
      target_thread_indexed: false,
      renderer_healthy: true,
    },
  },
  75,
  "large_context_checkpoint_handoff_unverified",
)
run(
  "large-context-checkpoint-safe",
  {
    ...base,
    context_handoff: {
      ...base.context_handoff,
      used: true,
      large_context: true,
      manual_checkpoint_route_used: true,
      source_checkpoint_exported: true,
      source_thread_preserved: true,
      target_thread_created: true,
      target_thread_indexed: true,
      renderer_healthy: true,
    },
  },
  0,
  "background_automation_continuity_verified",
)
run(
  "large-context-handoff-auto-replay",
  {
    ...base,
    context_handoff: {
      ...base.context_handoff,
      used: true,
      large_context: true,
      manual_checkpoint_route_used: true,
      source_checkpoint_exported: true,
      source_thread_preserved: true,
      target_thread_created: true,
      target_thread_indexed: true,
      renderer_healthy: true,
      automatic_replay_attempted: true,
    },
  },
  64,
  "context_handoff_replay_forbidden",
)
run(
  "prohibited-route",
  { ...base, route: "automatic gateway selector" },
  64,
  "prohibited_route_metadata",
)

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex background automation continuity guard self-test passed")
