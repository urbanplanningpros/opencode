import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-windows-control-surface-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-control-surface-"))

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
  task_id: "task-windows-control",
  operation_id: "operation-windows-control",
  idempotency_key: "idem-windows-control",
  platform: "Windows 11 x64",
  desktop_release: "26.721.41059",
  store_package: "26.721.4979.0",
  codex_cli_version: "0.146.0",
  wmi_inventory_powershell_starts_30s: 0,
  total_powershell_starts_30s: 0,
  conhost_starts_30s: 0,
  git_starts_60s: 0,
  maximum_low_level_input_delay_ms: 0,
  system_wide_input_lag_observed: false,
  automatic_git_origin_discovery_observed: false,
  desktop_execution_isolated: false,
  process_evidence_preserved: true,
  canonical_task_state_reconciled: true,
  external_writes_reconciled: true,
  signed_store_package_modified: false,
  build_specific_asar_patch_applied: false,
  generic_process_kill_requested: false,
  per_key_composer_crash_observed: false,
  crash_reason: "",
  crash_thread: "",
  crash_module: "",
  crash_evidence_preserved: true,
  desktop_composer_input_isolated: false,
  batch_paste_canary_passed: false,
  automatic_relaunch_attempted: false,
  wsl_project: false,
  pull_requests_tab_error: "",
  gh_pr_list_verified: false,
  github_connector_readback_verified: false,
  desktop_pr_tab_isolated: false,
  pr_mutation_requested: false,
  pr_mutation_idempotency_verified: false,
  pr_post_write_readback_verified: false,
  reroute_target: "none",
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
}

run("safe", base, 0, "compatible")
run("wmi-needs-isolation", {
  ...base,
  wmi_inventory_powershell_starts_30s: 5,
  total_powershell_starts_30s: 7,
  conhost_starts_30s: 79,
  system_wide_input_lag_observed: true,
}, 75, "remediation_required", "isolate_windows_desktop_execution_surface")
run("wmi-contained", {
  ...base,
  wmi_inventory_powershell_starts_30s: 5,
  total_powershell_starts_30s: 7,
  conhost_starts_30s: 79,
  system_wide_input_lag_observed: true,
  desktop_execution_isolated: true,
  reroute_target: "approved_linux_vps",
  routing: { ...base.routing, provider: "approved-local", route: "approved_linux_vps" },
}, 0, "compatible")
run("unsafe-asar", { ...base, build_specific_asar_patch_applied: true }, 64, "blocked", "unsupported_build_specific_asar_patch_forbidden")
run("composer-crash", {
  ...base,
  per_key_composer_crash_observed: true,
  crash_reason: "EXCEPTION_BREAKPOINT",
  crash_thread: "CrBrowserMain",
  crash_module: "chrome.dll",
  desktop_composer_input_isolated: false,
}, 75, "remediation_required", "isolate_per_key_windows_desktop_composer_input")
run("composer-unreconciled", {
  ...base,
  per_key_composer_crash_observed: true,
  crash_reason: "EXCEPTION_BREAKPOINT",
  crash_thread: "CrBrowserMain",
  crash_module: "chrome.dll",
  crash_evidence_preserved: false,
}, 64, "blocked", "crash_evidence_must_be_preserved")
run("wsl-pr-read", {
  ...base,
  wsl_project: true,
  pull_requests_tab_error: 'gh: Expected VAR_SIGN, actual: COLON (":") at [2, 9]',
  gh_pr_list_verified: true,
  desktop_pr_tab_isolated: true,
}, 0, "compatible")
run("wsl-pr-no-readback", {
  ...base,
  wsl_project: true,
  pull_requests_tab_error: 'gh: Expected VAR_SIGN, actual: COLON (":") at [2, 9]',
}, 64, "blocked", "authoritative_pull_request_readback_required")
run("wsl-pr-write-no-idempotency", {
  ...base,
  wsl_project: true,
  pull_requests_tab_error: 'gh: Expected VAR_SIGN, actual: COLON (":") at [2, 9]',
  gh_pr_list_verified: true,
  desktop_pr_tab_isolated: true,
  pr_mutation_requested: true,
  pr_post_write_readback_verified: true,
}, 64, "blocked", "pr_mutation_idempotency_required")
run("prohibited-route", {
  ...base,
  reroute_target: "none",
  routing: { provider: "openrouter", route: "auto-select", automatic_selector: true, model_gateway: true },
}, 64, "blocked", "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Windows control-surface continuity guard self-test passed")
