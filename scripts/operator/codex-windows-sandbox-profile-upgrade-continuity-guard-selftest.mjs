import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"

const guard = new URL("./codex-windows-sandbox-profile-upgrade-continuity-guard.mjs", import.meta.url).pathname
const dir = mkdtempSync(path.join(os.tmpdir(), "codex-win-upgrade-guard-"))

const base = {
  operation_id: "op-36235",
  task_id: "task-36235",
  platform: "windows-11",
  desktop_version: "26.721.11231.0",
  feature_upgrade_requested: true,
  codex_sandbox_offline_present: true,
  codex_sandbox_online_present: true,
  profile_list_registration_present: true,
  profile_directory_present: true,
  migration_failure_observed: true,
  expected_error_signature_observed: true,
  setup_logs_preserved: true,
  task_state_checkpointed: true,
  repository_writes_reconciled: true,
  external_writes_reconciled: true,
  automatic_upgrade_retry_suppressed: true,
  manual_registry_deletion_requested: false,
  manual_profile_deletion_requested: false,
  supported_teardown_receipt: false,
  system_backup_verified: false,
  disposable_upgrade_canary_passed: false,
  post_upgrade_sandbox_recreated: false,
  post_upgrade_codex_canary_passed: false,
  fallback_route: "approved_local_linux",
}

function run(name, patch = {}) {
  const file = path.join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify({ ...base, ...patch }))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  const output = JSON.parse(result.stdout || result.stderr)
  return { ...output, status: result.status }
}

try {
  assert.equal(run("rerouted").reason, "windows_feature_upgrade_isolated_operator_work_rerouted")
  assert.equal(run("no-route", { fallback_route: "none" }).status, 75)
  assert.equal(run("unreconciled", { repository_writes_reconciled: false }).reason, "operator_state_reconciliation_required_before_host_service")
  assert.equal(run("missing-logs", { setup_logs_preserved: false }).reason, "migration_failure_evidence_incomplete")
  assert.equal(run("retry-not-suppressed", { automatic_upgrade_retry_suppressed: false }).reason, "automatic_feature_upgrade_retry_must_be_suppressed")
  assert.equal(run("manual-delete", { manual_registry_deletion_requested: true }).status, 64)
  assert.equal(run("prohibited-route", { fallback_route: "bedrock" }).status, 64)
  assert.equal(run("preflight-clear", {
    codex_sandbox_offline_present: false,
    codex_sandbox_online_present: false,
    profile_list_registration_present: false,
    profile_directory_present: false,
    migration_failure_observed: false,
    fallback_route: "none",
  }).reason, "feature_upgrade_preflight_clear")
  assert.equal(run("teardown-no-canary", { supported_teardown_receipt: true }).reason, "backup_and_disposable_upgrade_canary_required")
  const recovered = run("recovered", {
    supported_teardown_receipt: true,
    system_backup_verified: true,
    disposable_upgrade_canary_passed: true,
    post_upgrade_sandbox_recreated: true,
    post_upgrade_codex_canary_passed: true,
    fallback_route: "none",
  })
  assert.equal(recovered.status, 0)
  assert.equal(recovered.reason, "windows_feature_upgrade_and_codex_sandbox_recovery_verified")
  console.log("10 deterministic fixtures passed")
} finally {
  rmSync(dir, { recursive: true, force: true })
}
