#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-windows-headless-sandbox-continuity-guard.mjs"

const base = () => ({
  mode: "windows_headless_sandbox_spawn",
  operation_id: "op-win-sandbox-36328",
  observed: {
    platform: "windows",
    surface: "codex_exec",
    approval_mode: "never",
    error_code: 1344,
    home_directory_write_root_expansion: true,
    shell_path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  },
  state: {
    task_state_checkpointed: true,
    repository_writes_reconciled: true,
    connector_writes_reconciled: true,
    deployment_writes_reconciled: true,
  },
  recovery: {
    scoped_project_workdir: true,
    workdir_is_not_user_home: true,
    workdir_identity_verified: true,
    write_root_count_bounded: true,
    write_root_count: 12,
    write_root_limit: 64,
    project_workdir: "C:\\work\\project",
    only_per_user_windowsapps_removed: true,
    machine_wide_shell_resolved: true,
    shell_readable_by_sandbox_identity: true,
    shell_executable_by_sandbox_identity: true,
    resolved_shell_path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    sandbox_spawn_canary_passed: true,
    harmless_command_canary_passed: true,
  },
  continuity_route: {
    type: "direct_openai_cli",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
    pinned_openai_model: true,
    excluded_provider_dependency_absent: true,
    model_gateway_present: false,
    automatic_model_selection_enabled: false,
    excluded_provider_dependency_present: false,
  },
  requested_action: {},
})

const fixtures = [
  ["healthy unrelated execution", () => ({ ...base(), observed: { ...base().observed, error_code: 5 } }), true, "windows_headless_sandbox_not_affected"],
  ["missing operation id", () => ({ ...base(), operation_id: "" }), false, "malformed_evidence"],
  ["broad pause rejected", () => ({ ...base(), state: { ...base().state, broad_operator_pause_requested: true } }), false, "broad_containment_rejected"],
  ["task replay rejected", () => ({ ...base(), state: { ...base().state, parent_task_replay_requested: true } }), false, "unsafe_replay_rejected"],
  ["gateway rejected", () => ({ ...base(), continuity_route: { ...base().continuity_route, model_gateway_present: true } }), false, "route_authority_invalid"],
  ["unsandboxed recovery rejected", () => ({ ...base(), requested_action: { run_unsandboxed: true } }), false, "unsafe_windows_sandbox_recovery"],
  ["state checkpoint required", () => ({ ...base(), state: { ...base().state, repository_writes_reconciled: false } }), false, "state_reconciliation_required"],
  ["home workdir must be narrowed", () => ({ ...base(), recovery: { ...base().recovery, workdir_is_not_user_home: false } }), false, "home_workdir_dacl_risk_unresolved"],
  ["write root limit enforced", () => ({ ...base(), recovery: { ...base().recovery, write_root_count: 100 } }), false, "home_workdir_dacl_risk_unresolved"],
  ["windowsapps shell rejected", () => ({ ...base(), observed: { ...base().observed, error_code: 1920, shell_path: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" }, recovery: { ...base().recovery, resolved_shell_path: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" } }), false, "sandbox_shell_path_unresolved"],
  ["sandbox canary required", () => ({ ...base(), recovery: { ...base().recovery, sandbox_spawn_canary_passed: false } }), false, "sandbox_canary_required"],
  ["unapproved route rejected", () => ({ ...base(), continuity_route: { ...base().continuity_route, type: "external_gateway" } }), false, "unapproved_continuity_route"],
  ["api route not used for local spawn", () => ({ ...base(), continuity_route: { ...base().continuity_route, type: "direct_openai_api" } }), false, "windows_exec_route_invalid"],
  ["1344 recovery admitted", () => base(), true, "windows_headless_sandbox_failure_contained"],
  ["1920 recovery admitted", () => ({ ...base(), observed: { ...base().observed, error_code: 1920, home_directory_write_root_expansion: false, shell_path: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" } }), true, "windows_headless_sandbox_failure_contained"],
]

for (const [name, build, admitted, reason] of fixtures) {
  const result = evaluate(build())
  assert.equal(result.admitted, admitted, name)
  assert.equal(result.reason, reason, name)
}

process.stdout.write(`passed ${fixtures.length} fixtures\n`)
