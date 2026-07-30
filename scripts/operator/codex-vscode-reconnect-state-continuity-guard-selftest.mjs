import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-vscode-reconnect-state-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-vscode-reconnect-state-"))

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

const scopeHash = "4".repeat(64)
const base = {
  task_id: "task-vscode-reconnect",
  thread_id: "thread-vscode-reconnect",
  operation_id: "operation-vscode-reconnect",
  idempotency_key: "idem-vscode-reconnect",
  platform: "Windows 11 x64",
  remote_platform: "Linux x86_64",
  ide_extension_version: "26.721.41059",
  vscode_version: "1.131.0",
  workspace_path: "/srv/project",
  permission_scope_sha256: scopeHash,
  remote_connection_reconnected: false,
  pre_disconnect_permission_profile: "full_access",
  post_reconnect_visible_permission_profile: "full_access",
  post_reconnect_runtime_permission_profile: "full_access",
  repeated_approval_prompts_after_reconnect: false,
  chat_state_rehydrated: true,
  submitted_message_readback_passed: true,
  chat_scroll_state_stable: true,
  canonical_thread_preserved: true,
  permission_receipt_preserved: true,
  canonical_task_state_reconciled: true,
  repository_state_reconciled: true,
  external_writes_reconciled: true,
  explicit_reauthorization_received: false,
  mutation_authority_requested: false,
  automatic_task_replay_requested: false,
  replacement_goal_created_before_reconciliation: false,
  fresh_goal_permission_canary_passed: true,
  reroute_target: "none",
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
}

const incident = {
  ...base,
  remote_connection_reconnected: true,
  post_reconnect_visible_permission_profile: "full_access",
  post_reconnect_runtime_permission_profile: "workspace_write",
  repeated_approval_prompts_after_reconnect: true,
  chat_state_rehydrated: false,
  submitted_message_readback_passed: false,
  chat_scroll_state_stable: false,
  permission_receipt_preserved: false,
  fresh_goal_permission_canary_passed: false,
}

run("safe", base, 0, "compatible")
run("incident-needs-rehydration", incident, 75, "remediation_required", "rehydrate_chat_from_canonical_thread")
run("incident-preserve-receipt", incident, 75, "remediation_required", "preserve_pre_disconnect_permission_receipt")
run("mutation-without-reauthorization", { ...incident, mutation_authority_requested: true }, 64, "blocked", "mutation_authority_requires_explicit_reauthorization")
run("unreconciled-writes", { ...incident, external_writes_reconciled: false }, 64, "blocked", "external_writes_must_be_reconciled")
run("automatic-replay", { ...incident, automatic_task_replay_requested: true }, 64, "blocked", "automatic_task_replay_forbidden")
run("premature-replacement", { ...incident, replacement_goal_created_before_reconciliation: true }, 64, "blocked", "replacement_goal_before_reconciliation_forbidden")
run("approved-reroute", {
  ...incident,
  permission_receipt_preserved: true,
  explicit_reauthorization_received: true,
  reroute_target: "direct_remote_codex_cli",
}, 75, "remediation_required", "rehydrate_chat_from_canonical_thread")
run("recovered", {
  ...incident,
  permission_receipt_preserved: true,
  post_reconnect_visible_permission_profile: "workspace_write",
  post_reconnect_runtime_permission_profile: "workspace_write",
  repeated_approval_prompts_after_reconnect: false,
  chat_state_rehydrated: true,
  submitted_message_readback_passed: true,
  chat_scroll_state_stable: true,
  explicit_reauthorization_received: true,
  fresh_goal_permission_canary_passed: true,
}, 0, "compatible")
run("prohibited-route", {
  ...incident,
  routing: { provider: "openrouter", route: "auto-select", automatic_selector: true, model_gateway: true },
}, 64, "blocked", "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex VS Code reconnect state continuity guard self-test passed")
