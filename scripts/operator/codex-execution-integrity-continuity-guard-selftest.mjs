#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-execution-integrity-continuity-guard.mjs"

const base = () => ({
  operation_id: "op-36330-36348",
  state: {
    task_state_checkpointed: true,
    repository_writes_reconciled: true,
    connector_writes_reconciled: true,
    deployment_writes_reconciled: true,
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
})

const cases = [
  {
    name: "rejects missing operation id",
    evidence: { mode: "remote_process_lifecycle" },
    admitted: false,
    reason: "malformed_evidence",
  },
  {
    name: "rejects excluded provider dependency",
    evidence: (() => { const x = base(); x.mode = "remote_process_lifecycle"; x.continuity_route.excluded_provider_dependency_present = true; return x })(),
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "healthy remote is admitted",
    evidence: { ...base(), mode: "remote_process_lifecycle", observed: { surface: "ssh_remote_app_server", zombie_count: 0 } },
    admitted: true,
    reason: "remote_process_lifecycle_not_affected",
  },
  {
    name: "remote broad kill is rejected",
    evidence: { ...base(), mode: "remote_process_lifecycle", observed: { surface: "ssh_remote_app_server", zombie_count: 100000 }, requested_action: { kill_all_codex_processes: true } },
    admitted: false,
    reason: "unsafe_remote_recovery",
  },
  {
    name: "remote lifecycle recovery is admitted",
    evidence: { ...base(), mode: "remote_process_lifecycle", observed: { surface: "ssh_remote_app_server", zombie_count: 100000, child_process_count: 125000, open_file_descriptor_count: 378000, unbounded_git_spawn_loop: true }, recovery: { exact_app_server_identity_verified: true, process_tree_ownership_verified: true, pre_restart_process_inventory_recorded: true, pre_restart_repository_receipt_recorded: true, only_affected_app_server_restarted: true, git_refresh_single_flight: true, child_reaping_canary_passed: true, zombie_count_returned_to_baseline: true, fd_count_returned_to_baseline: true, thread_state_rehydrated_without_replay: true } },
    admitted: true,
    reason: "remote_process_lifecycle_contained",
  },
  {
    name: "browser same wake retry is rejected",
    evidence: { ...base(), mode: "browser_heartbeat_finalize", observed: { platform: "windows", surface: "in_app_browser_heartbeat", finalize_timeout: true }, requested_action: { retry_same_wake: true } },
    admitted: false,
    reason: "unsafe_browser_heartbeat_recovery",
  },
  {
    name: "browser circuit breaker is admitted",
    evidence: { ...base(), mode: "browser_heartbeat_finalize", observed: { platform: "windows", surface: "in_app_browser_heartbeat", finalize_timeout: true, browser_kernel_reset: true }, recovery: { browser_circuit_breaker_open: true, same_wake_retry_suppressed: true, non_browser_gate_continues: true, browser_binding_marked_uncertain: true, cleanup_timeout_receipt_recorded: true, direct_api_or_connector_fallback_used: true, browser_authority_restored: false } },
    admitted: true,
    reason: "browser_heartbeat_failure_contained",
  },
  {
    name: "premature browser restore is rejected",
    evidence: { ...base(), mode: "browser_heartbeat_finalize", observed: { platform: "windows", surface: "in_app_browser_heartbeat", finalize_timeout: true }, recovery: { browser_circuit_breaker_open: true, same_wake_retry_suppressed: true, non_browser_gate_continues: true, browser_binding_marked_uncertain: true, cleanup_timeout_receipt_recorded: true, browser_work_deferred_until_canary: true, browser_authority_restored: true } },
    admitted: false,
    reason: "premature_browser_authority_restore",
  },
  {
    name: "wrong window fallback is rejected",
    evidence: { ...base(), mode: "computer_use_window_binding", observed: { surface: "computer_use_window_binding", wrong_window_content_captured: true }, requested_action: { accept_fallback_window: true } },
    admitted: false,
    reason: "unsafe_window_binding_recovery",
  },
  {
    name: "verified window rebind is admitted",
    evidence: { ...base(), mode: "computer_use_window_binding", observed: { surface: "computer_use_window_binding", same_owner_rejected: true }, recovery: { fresh_window_inventory_taken: true, window_identity_bound_to_pid_and_process_start: true, app_id_and_hwnd_match: true, title_fingerprint_match: true, visible_nonce_canary_match: true, screenshot_scope_verified: true, computer_use_authority_restored: true, two_consecutive_target_capture_canaries_passed: true, target_app_id: "blender.4.5", target_window_id: "4918426" } },
    admitted: true,
    reason: "computer_use_window_binding_contained",
  },
  {
    name: "unsandboxed patch retry is rejected",
    evidence: { ...base(), mode: "windows_apply_patch", observed: { platform: "windows", surface: "apply_patch", sandbox_mode: "unelevated", approval_request_aborted: true }, requested_action: { retry_without_sandbox: true } },
    admitted: false,
    reason: "unsafe_apply_patch_recovery",
  },
  {
    name: "atomic patch shim is admitted",
    evidence: { ...base(), mode: "windows_apply_patch", observed: { platform: "windows", surface: "apply_patch", sandbox_mode: "unelevated", os_error_code: 5 }, recovery: { target_path_inside_verified_worktree: true, expected_content_hash_recorded: true, same_directory_temp_file_used: true, atomic_rename_used: true, final_content_hash_verified: true, git_diff_receipt_recorded: true, no_unsandboxed_execution: true, target_path: "scripts/operator/example.mjs", final_content_hash: "sha256:abc" } },
    admitted: true,
    reason: "windows_apply_patch_failure_contained",
  },
  {
    name: "incomplete atomic patch shim is rejected",
    evidence: { ...base(), mode: "windows_apply_patch", observed: { platform: "windows", surface: "apply_patch", sandbox_mode: "unelevated", stderr: "Access is denied" }, recovery: { target_path_inside_verified_worktree: true } },
    admitted: false,
    reason: "atomic_patch_shim_incomplete",
  },
  {
    name: "broad pause is rejected",
    evidence: (() => { const x = base(); x.mode = "browser_heartbeat_finalize"; x.state.broad_operator_pause_requested = true; return x })(),
    admitted: false,
    reason: "broad_containment_rejected",
  },
  {
    name: "unsupported mode is rejected",
    evidence: { ...base(), mode: "unknown" },
    admitted: false,
    reason: "unsupported_mode",
  },
]

for (const fixture of cases) {
  const result = evaluate(fixture.evidence)
  assert.equal(result.admitted, fixture.admitted, fixture.name)
  assert.equal(result.reason, fixture.reason, fixture.name)
}

console.log(`passed ${cases.length} deterministic fixtures`)
