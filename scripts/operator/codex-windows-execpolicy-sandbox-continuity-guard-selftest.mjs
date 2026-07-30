import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-windows-execpolicy-sandbox-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-execpolicy-sandbox-"))

function run(name, evidence, expectedExit, expectedStatus, expectedToken = null) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedExit, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.status, expectedStatus)
  if (expectedToken) {
    const tokens = [...report.blocked, ...report.remediation, ...report.warnings]
    assert.equal(tokens.includes(expectedToken), true, `${name}: missing ${expectedToken}`)
  }
}

const base = {
  task_id: "task-windows-policy-sandbox",
  operation_id: "operation-windows-policy-sandbox",
  idempotency_key: "idem-windows-policy-sandbox",
  platform: "Microsoft Windows NT 10.0.19045.0 x64",
  shell: "PowerShell 7.6.4",
  codex_cli_version: "0.146.0",
  durable_allow_requested: false,
  bare_command_invocation: false,
  logical_command: "",
  resolved_launcher_path: "",
  resolved_launcher_sha256: "",
  launcher_kind: "",
  resolved_target_regular_file: false,
  resolved_target_symlink: false,
  launcher_hash_verified: false,
  exact_target_selected_before_approval: false,
  policy_checked_logical_name: false,
  policy_checked_bound_path: false,
  strictest_decision_preserved: false,
  execution_uses_bound_target: false,
  second_name_lookup_possible: false,
  resolver_ambiguous: false,
  compound_or_pipeline_command: false,
  windows_sandbox_mode: "native",
  sandbox_healthcheck_path: "C:\\work\\repo\\.codex_patch_healthcheck.tmp",
  workspace_root: "C:\\work\\repo",
  sandbox_create_succeeded: false,
  sandbox_read_failed: false,
  sandbox_error_code: "",
  retry_without_sandbox_requested: false,
  automatic_unsandboxed_retry_attempted: false,
  healthcheck_path_within_workspace: true,
  healthcheck_regular_file: true,
  healthcheck_symlink: false,
  sandbox_failure_receipt_preserved: true,
  canonical_task_state_reconciled: true,
  external_writes_reconciled: true,
  exact_fallback_operation_bound: false,
  fallback_mutation_class: "",
  approved_host_verifier_sha256: "",
  approved_host_verifier_verified: false,
  no_duplicate_mutation_verified: true,
  post_fallback_readback_verified: true,
  reroute_target: "none",
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
}

run("safe", base, 0, "compatible")

run("bare-allow-unbound", {
  ...base,
  durable_allow_requested: true,
  bare_command_invocation: true,
  logical_command: "playwright-cli",
  launcher_kind: "ps1",
}, 64, "blocked", "resolved_launcher_path_required")

run("bare-allow-second-lookup", {
  ...base,
  durable_allow_requested: true,
  bare_command_invocation: true,
  logical_command: "playwright-cli",
  resolved_launcher_path: "C:\\Users\\operator\\AppData\\Roaming\\npm\\playwright-cli.ps1",
  resolved_launcher_sha256: "a".repeat(64),
  launcher_kind: "ps1",
  resolved_target_regular_file: true,
  launcher_hash_verified: true,
  exact_target_selected_before_approval: true,
  policy_checked_logical_name: true,
  policy_checked_bound_path: true,
  strictest_decision_preserved: true,
  execution_uses_bound_target: true,
  second_name_lookup_possible: true,
  reroute_target: "absolute_bound_windows_launcher",
}, 64, "blocked", "second_name_lookup_forbidden")

run("bare-allow-bound", {
  ...base,
  durable_allow_requested: true,
  bare_command_invocation: true,
  logical_command: "playwright-cli",
  resolved_launcher_path: "C:\\Users\\operator\\AppData\\Roaming\\npm\\playwright-cli.ps1",
  resolved_launcher_sha256: "b".repeat(64),
  launcher_kind: "ps1",
  resolved_target_regular_file: true,
  launcher_hash_verified: true,
  exact_target_selected_before_approval: true,
  policy_checked_logical_name: true,
  policy_checked_bound_path: true,
  strictest_decision_preserved: true,
  execution_uses_bound_target: true,
  second_name_lookup_possible: false,
  reroute_target: "absolute_bound_windows_launcher",
}, 0, "compatible")

run("sandbox-needs-route", {
  ...base,
  sandbox_create_succeeded: true,
  sandbox_read_failed: true,
  sandbox_error_code: "PATCH_SERVICE_UNAVAILABLE",
  retry_without_sandbox_requested: true,
  exact_fallback_operation_bound: true,
  fallback_mutation_class: "read_only",
}, 75, "remediation_required", "isolate_only_affected_windows_sandbox_helper")

run("sandbox-auto-unsandboxed-retry", {
  ...base,
  sandbox_create_succeeded: true,
  sandbox_read_failed: true,
  sandbox_error_code: "PATCH_SERVICE_UNAVAILABLE",
  retry_without_sandbox_requested: true,
  automatic_unsandboxed_retry_attempted: true,
  exact_fallback_operation_bound: true,
  fallback_mutation_class: "read_only",
}, 64, "blocked", "automatic_unsandboxed_retry_forbidden")

run("sandbox-read-verifier", {
  ...base,
  sandbox_create_succeeded: true,
  sandbox_read_failed: true,
  sandbox_error_code: "PATCH_SERVICE_UNAVAILABLE",
  retry_without_sandbox_requested: true,
  exact_fallback_operation_bound: true,
  fallback_mutation_class: "read_only",
  approved_host_verifier_sha256: "c".repeat(64),
  approved_host_verifier_verified: true,
  reroute_target: "approved_host_verifier",
  routing: { ...base.routing, provider: "approved-local", route: "approved_host_verifier" },
}, 0, "compatible", "one_time_read_only_host_verifier_in_use")

run("sandbox-mutation-unreconciled", {
  ...base,
  sandbox_create_succeeded: true,
  sandbox_read_failed: true,
  sandbox_error_code: "PATCH_SERVICE_UNAVAILABLE",
  retry_without_sandbox_requested: true,
  exact_fallback_operation_bound: true,
  fallback_mutation_class: "update",
  no_duplicate_mutation_verified: false,
  reroute_target: "authorized_local_linux",
  routing: { ...base.routing, provider: "approved-local", route: "authorized_local_linux" },
}, 64, "blocked", "duplicate_mutation_reconciliation_required")

run("sandbox-linux-reroute", {
  ...base,
  sandbox_create_succeeded: true,
  sandbox_read_failed: true,
  sandbox_error_code: "PATCH_SERVICE_UNAVAILABLE",
  retry_without_sandbox_requested: true,
  exact_fallback_operation_bound: true,
  fallback_mutation_class: "update",
  no_duplicate_mutation_verified: true,
  post_fallback_readback_verified: true,
  reroute_target: "authorized_local_linux",
  routing: { ...base.routing, provider: "approved-local", route: "authorized_local_linux" },
}, 0, "compatible")

run("prohibited-route", {
  ...base,
  reroute_target: "none",
  routing: { provider: "openrouter", route: "auto-select", automatic_selector: true, model_gateway: true },
}, 64, "blocked", "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Windows execpolicy/sandbox continuity guard self-test passed")
