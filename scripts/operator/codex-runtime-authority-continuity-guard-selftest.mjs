#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-runtime-authority-continuity-guard.mjs"

const state = {
  task_state_checkpointed: true,
  repository_writes_reconciled: true,
  connector_writes_reconciled: true,
  deployment_writes_reconciled: true,
}
const route = {
  type: "direct_openai_api",
  verified: true,
  canary_passed: true,
  operation_binding_matches: true,
  pinned_openai_model: true,
  excluded_provider_dependency_absent: true,
}
const base = (mode) => ({ mode, operation_id: `op-${mode}`, state, continuity_route: route })
const fixtures = [
  [{ mode: "runtime_authority" }, false, "malformed_evidence"],
  [{ ...base("runtime_authority"), requested_runtime: { model: "gpt-5.6-terra" }, observed_runtime: { receipt_present: true, model: "gpt-5.6-terra", provider: "openai" } }, true, "runtime_authority_verified"],
  [{ ...base("runtime_authority"), requested_runtime: { model: "gpt-5.6-terra" }, observed_runtime: { receipt_present: true, model: "gpt-5.6-sol", provider: "openai" }, requested_action: { trust_config_without_readback: true } }, false, "runtime_drift_not_contained"],
  [{ ...base("runtime_authority"), requested_runtime: { model: "gpt-5.6-terra", service_tier: "default" }, observed_runtime: { receipt_present: true, model: "gpt-5.6-sol", provider: "openai", service_tier: "fast" }, continuity_route: { ...route, request_model: "gpt-5.6-terra", response_model: "gpt-5.6-terra", request_service_tier: "default", response_service_tier: "default" } }, true, "runtime_drift_contained"],
  [{ ...base("runtime_authority"), continuity_route: { type: "model_gateway" }, requested_runtime: { model: "gpt-5.6-terra" }, observed_runtime: { receipt_present: true, model: "gpt-5.6-sol", provider: "openai" } }, false, "unapproved_continuity_route"],
  [{ ...base("wsl_bootstrap"), observed: { platform: "windows", wsl_selected: true, state_db_backfill_running: true, initialize_result: "timeout" }, requested_action: { delete_state_db: true } }, false, "destructive_wsl_recovery_rejected"],
  [{ ...base("wsl_bootstrap"), observed: { platform: "windows", wsl_selected: true, state_db_backfill_running: true, initialize_result: "timeout" }, config: { config_toml_wsl: false, global_state_wsl: false, sources_reconciled: true, native_executable_observed: true, native_initialize_result: "success" }, continuity_route: { ...route, type: "approved_windows_native_openai" } }, true, "wsl_bootstrap_failure_contained"],
  [{ ...base("security_workspace"), consent: { tool_status: "declined", user_interaction_receipt_present: false }, requested_action: { apply_remediation_as_declined_or_approved: true } }, false, "synthetic_consent_rejected"],
  [{ ...base("security_workspace"), consent: { tool_status: "declined", user_interaction_receipt_present: false, synthetic_result_marked_invalid: true, remediation_mutation_withheld: true, read_only_scan_allowed: true, separate_approval_channel_prepared: true } }, true, "security_workspace_failure_contained"],
  [{ ...base("security_workspace"), workspace: { security_panel_opened: true, renderer_count: 28, prior_renderer_count: 27, backend_scan_healthy: true }, requested_action: { kill_by_process_name: true } }, false, "unsafe_security_workspace_recovery"],
  [{ ...base("security_workspace"), workspace: { security_panel_opened: true, renderer_count: 28, prior_renderer_count: 27, backend_scan_healthy: true, panel_quarantined: true, scan_id_preserved: true, backend_status_readback_present: true, new_renderer_spawns_stopped: true } }, true, "security_workspace_failure_contained"],
  [{ ...base("runtime_authority"), continuity_route: { ...route, excluded_provider_dependency_present: true }, requested_runtime: { model: "gpt-5.6-terra" }, observed_runtime: { receipt_present: true, model: "gpt-5.6-sol", provider: "openai" } }, false, "route_authority_invalid"],
]
for (const [evidence, admitted, reason] of fixtures) {
  const result = evaluate(evidence)
  assert.equal(result.admitted, admitted)
  assert.equal(result.reason, reason)
}
process.stdout.write(`passed ${fixtures.length} deterministic fixtures\n`)
