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
    expires_at: "2026-07-29T13:00:00Z",
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
}

run("safe", base, 0, "background_automation_continuity_verified")
run(
  "local-write",
  { ...base, execution_environment: "local", runtime_worktree_observed: false },
  75,
  "repository_writing_automation_not_isolated",
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
  "prohibited-route",
  { ...base, route: "automatic gateway selector" },
  64,
  "prohibited_route_metadata",
)

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex background automation continuity guard self-test passed")
