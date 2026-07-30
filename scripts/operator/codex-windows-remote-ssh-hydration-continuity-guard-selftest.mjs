import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-windows-remote-ssh-hydration-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-remote-ssh-hydration-"))

function run(name, evidence, expectedStatus, expectedState, expectedToken = null) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.status, expectedState)
  if (expectedToken) {
    assert.equal([...report.blocked, ...report.remediation, ...report.warnings].includes(expectedToken), true, `${name}: missing ${expectedToken}`)
  }
}

const base = {
  task_id: "task-remote-ssh",
  operation_id: "operation-remote-ssh",
  idempotency_key: "idem-remote-ssh",
  platform: "Windows 11 x64",
  remote_platform: "Linux x86_64",
  desktop_release: "26.721.11231.0",
  codex_cli_version: "0.146.0",
  remote_ssh_enabled: false,
  remote_ssh_auto_connect_enabled: false,
  concurrent_thread_resume_count: 0,
  app_server_in_flight_request_count: 0,
  app_server_queue_expired: false,
  maximum_queue_wait_ms: 0,
  slowest_thread_resume_ms: 0,
  websocket_close_code: "",
  maximum_jsonl_record_bytes: 0,
  managed_remote_daemon_alive: true,
  normal_ssh_transport_stable: true,
  server_cpu_saturated: false,
  server_memory_saturated: false,
  thread_inventory_preserved: true,
  offending_thread_ids: [],
  offending_threads_archived: false,
  offending_threads_deleted: false,
  pending_resume_operations_cancelled: false,
  hydration_queue_cleared: false,
  automatic_reconnect_stopped: false,
  managed_remote_daemon_restart_count: 0,
  daemon_restart_after_queue_clear: false,
  canonical_task_state_reconciled: true,
  external_writes_reconciled: true,
  post_recovery_connection_canary_passed: false,
  post_recovery_turn_start_ms: 0,
  interactive_request_priority_verified: false,
  automatic_task_replay_requested: false,
  replacement_thread_created_before_reconciliation: false,
  reroute_target: "none",
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
}

const incident = {
  ...base,
  remote_ssh_enabled: true,
  remote_ssh_auto_connect_enabled: true,
  concurrent_thread_resume_count: 5,
  app_server_in_flight_request_count: 6,
  app_server_queue_expired: true,
  maximum_queue_wait_ms: 30003,
  slowest_thread_resume_ms: 65397,
  websocket_close_code: "1006",
  maximum_jsonl_record_bytes: 1260000,
  offending_thread_ids: ["thread-large-1"],
}

run("safe", base, 0, "compatible")
run("incident-needs-archive", incident, 75, "remediation_required", "archive_offending_threads_reversibly")
run("incident-missing-thread-inventory", { ...incident, thread_inventory_preserved: false }, 64, "blocked", "thread_inventory_must_be_preserved")
run("incident-unreconciled-writes", { ...incident, external_writes_reconciled: false }, 64, "blocked", "external_writes_must_be_reconciled")
run("destructive-delete", { ...incident, offending_threads_deleted: true }, 64, "blocked", "destructive_thread_deletion_forbidden")
run("automatic-replay", { ...incident, automatic_task_replay_requested: true }, 64, "blocked", "automatic_task_replay_forbidden")
run("restart-loop", { ...incident, managed_remote_daemon_restart_count: 2 }, 64, "blocked", "repeated_remote_daemon_restart_forbidden")
run("restart-before-queue-clear", {
  ...incident,
  managed_remote_daemon_restart_count: 1,
  daemon_restart_after_queue_clear: false,
}, 64, "blocked", "remote_daemon_restart_must_follow_queue_clear")
run("approved-reroute", {
  ...incident,
  offending_threads_archived: true,
  pending_resume_operations_cancelled: true,
  hydration_queue_cleared: true,
  automatic_reconnect_stopped: true,
  managed_remote_daemon_restart_count: 1,
  daemon_restart_after_queue_clear: true,
  reroute_target: "direct_remote_codex_cli",
}, 0, "compatible", "interactive_request_priority_not_verified")
run("recovered", {
  ...incident,
  offending_threads_archived: true,
  pending_resume_operations_cancelled: true,
  hydration_queue_cleared: true,
  automatic_reconnect_stopped: true,
  managed_remote_daemon_restart_count: 1,
  daemon_restart_after_queue_clear: true,
  post_recovery_connection_canary_passed: true,
  post_recovery_turn_start_ms: 122,
  interactive_request_priority_verified: true,
}, 0, "compatible")
run("prohibited-route", {
  ...incident,
  reroute_target: "none",
  routing: { provider: "openrouter", route: "auto-select", automatic_selector: true, model_gateway: true },
}, 64, "blocked", "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Windows Remote SSH hydration continuity guard self-test passed")
