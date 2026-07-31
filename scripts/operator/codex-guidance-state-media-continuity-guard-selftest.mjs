#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-guidance-state-media-continuity-guard.mjs"

const base = (mode) => ({
  operation_id: `op-${mode}`,
  mode,
  state: {
    task_state_checkpointed: true,
    repository_writes_reconciled: true,
    connector_writes_reconciled: true,
    deployment_writes_reconciled: true,
    external_write_ledger_reconciled: true,
  },
  continuity_route: {
    type: "direct_openai_app_server",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
    pinned_openai_model: true,
    excluded_provider_dependency_absent: true,
    model_gateway_present: false,
    automatic_model_selection_enabled: false,
    excluded_provider_dependency_present: false,
    copilot_auto_selection_present: false,
    bedrock_present: false,
    vertex_present: false,
  },
})

const instruction = () => ({
  ...base("instruction_budget_integrity"),
  observed: {
    client: "codex",
    project_doc_max_bytes: 32768,
    instruction_chain_truncated: true,
    instruction_files: [
      { path: "AGENTS.md", bytes: 24000, critical: true },
      { path: "services/payments/AGENTS.override.md", bytes: 12000, critical: true },
    ],
    loaded_instruction_files: ["AGENTS.md", "services/payments/AGENTS.override.md"],
  },
  recovery: {
    instruction_inventory_recorded: true,
    file_sizes_and_hashes_recorded: true,
    root_to_cwd_order_recorded: true,
    critical_instruction_set_declared: true,
    budget_raised_above_total_chain: true,
    chain_compacted_below_budget: false,
    fresh_session_started_from_target_directory: true,
    loaded_sources_canary_passed: true,
    loaded_content_hashes_match_manifest: true,
  },
})

const rollout = () => ({
  ...base("restored_rollout_backfill"),
  observed: {
    backfill_marked_complete: true,
    backfill_completed_while_rollout_inventory_empty: true,
    restored_rollout_files: 336,
    indexed_thread_rows: 0,
  },
  recovery: {
    state_database_backup_created: true,
    rollout_inventory_manifest_created: true,
    rollout_hashes_verified: true,
    active_and_archived_counts_recorded: true,
    index_inventory_comparison_recorded: true,
    only_affected_history_resumption_withheld: true,
    active_worktrees_and_external_writes_preserved: true,
    recovery_manifest_bound_to_operation: true,
    desktop_history_authority_restored: false,
  },
})

const media = () => {
  const evidence = {
    ...base("macos_image_sandbox"),
    observed: {
      platform: "macos",
      fs_sandbox_signal: 9,
      view_image_failed: true,
      image_gen_local_reference_failed: true,
    },
    recovery: {
      source_file_exists: true,
      source_sha256_recorded: true,
      source_byte_count_recorded: true,
      source_mime_and_dimensions_recorded: true,
      source_decodes_with_authorized_local_tool: true,
      reference_rebound_to_existing_operation: true,
      source_hash_bound_to_generation_request: true,
      output_receipt_recorded: true,
      only_local_path_media_surface_quarantined: true,
      source_sha256: "sha256:abc",
      local_path_media_authority_restored: false,
    },
  }
  evidence.continuity_route.type = "direct_openai_image_api"
  return evidence
}

const cases = [
  { name: "rejects missing operation id", evidence: { mode: "instruction_budget_integrity" }, admitted: false, reason: "malformed_evidence" },
  { name: "rejects broad pause", evidence: (() => { const x = instruction(); x.state.broad_operator_pause_requested = true; return x })(), admitted: false, reason: "broad_containment_rejected" },
  { name: "rejects gateway routing", evidence: (() => { const x = instruction(); x.continuity_route.model_gateway_present = true; return x })(), admitted: false, reason: "route_authority_invalid" },
  { name: "admits healthy instruction chain", evidence: { ...base("instruction_budget_integrity"), observed: { client: "codex", project_doc_max_bytes: 32768, instruction_files: [{ path: "AGENTS.md", bytes: 4000, critical: true }], loaded_instruction_files: ["AGENTS.md"] } }, admitted: true, reason: "instruction_chain_within_verified_budget" },
  { name: "rejects per-file budget assumption", evidence: (() => { const x = instruction(); x.requested_action = { assume_project_doc_limit_is_per_file: true }; return x })(), admitted: false, reason: "instruction_budget_semantics_rejected" },
  { name: "requires instruction inventory", evidence: (() => { const x = instruction(); x.recovery.file_sizes_and_hashes_recorded = false; return x })(), admitted: false, reason: "instruction_inventory_required" },
  { name: "requires larger or compacted cumulative budget", evidence: (() => { const x = instruction(); x.recovery.budget_raised_above_total_chain = false; return x })(), admitted: false, reason: "instruction_chain_exceeds_cumulative_budget" },
  { name: "admits verified instruction continuity", evidence: instruction(), admitted: true, reason: "instruction_budget_failure_contained" },
  { name: "admits consistent rollout inventory", evidence: { ...base("restored_rollout_backfill"), observed: { backfill_marked_complete: true, backfill_completed_while_rollout_inventory_empty: false, restored_rollout_files: 10, indexed_thread_rows: 10 } }, admitted: true, reason: "rollout_index_inventory_consistent" },
  { name: "rejects direct SQL backfill repair", evidence: (() => { const x = rollout(); x.requested_action = { rearm_backfill_with_direct_sql: true }; return x })(), admitted: false, reason: "unsupported_state_repair_rejected" },
  { name: "requires recovery manifest", evidence: (() => { const x = rollout(); x.recovery.rollout_hashes_verified = false; return x })(), admitted: false, reason: "recovery_manifest_required" },
  { name: "admits contained unindexed history", evidence: rollout(), admitted: true, reason: "restored_rollout_index_failure_contained" },
  { name: "rejects premature history authority restore", evidence: (() => { const x = rollout(); x.recovery.desktop_history_authority_restored = true; return x })(), admitted: false, reason: "premature_history_authority_restore" },
  { name: "admits history after supported reconciliation canaries", evidence: (() => { const x = rollout(); x.recovery.desktop_history_authority_restored = true; x.recovery.supported_reindex_or_fixed_build_used = true; x.recovery.restored_file_count_matches_indexed_row_count = true; x.recovery.random_thread_readback_canary_passed = true; x.recovery.active_and_archived_visibility_canary_passed = true; return x })(), admitted: true, reason: "restored_rollout_index_failure_contained" },
  { name: "admits healthy local image sandbox", evidence: { ...base("macos_image_sandbox"), observed: { platform: "macos", fs_sandbox_signal: 0 } }, admitted: true, reason: "local_image_sandbox_not_affected" },
  { name: "rejects disabling filesystem sandbox", evidence: (() => { const x = media(); x.requested_action = { disable_filesystem_sandbox: true }; return x })(), admitted: false, reason: "unsafe_media_recovery_rejected" },
  { name: "requires media identity receipt", evidence: (() => { const x = media(); x.recovery.source_sha256_recorded = false; return x })(), admitted: false, reason: "media_identity_receipt_required" },
  { name: "rejects non-media-capable route", evidence: (() => { const x = media(); x.continuity_route.type = "direct_openai_cli"; return x })(), admitted: false, reason: "media_route_not_capable" },
  { name: "admits direct image API continuity", evidence: media(), admitted: true, reason: "macos_image_sandbox_failure_contained" },
  { name: "rejects premature local path media restore", evidence: (() => { const x = media(); x.recovery.local_path_media_authority_restored = true; return x })(), admitted: false, reason: "premature_media_authority_restore" },
  { name: "admits media restore after all canaries", evidence: (() => { const x = media(); x.recovery.local_path_media_authority_restored = true; x.recovery.workspace_view_image_canary_passed = true; x.recovery.generated_image_read_canary_passed = true; x.recovery.attachment_read_canary_passed = true; x.recovery.image_to_image_reference_canary_passed = true; return x })(), admitted: true, reason: "macos_image_sandbox_failure_contained" },
  { name: "rejects unsupported mode", evidence: { ...base("unknown"), mode: "unknown" }, admitted: false, reason: "unsupported_mode" },
]

for (const fixture of cases) {
  const result = evaluate(fixture.evidence)
  assert.equal(result.admitted, fixture.admitted, fixture.name)
  assert.equal(result.reason, fixture.reason, fixture.name)
}

console.log(`passed ${cases.length} deterministic fixtures`)
