#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROUTES = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_ssh_remote_openai",
  "approved_windows_native_openai",
  "direct_openai_image_api",
  "canonical_chat_attachment",
])

const t = (value) => String(value ?? "").trim()
const lower = (value) => t(value).toLowerCase()
const b = (value) => value === true
const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0
const out = (admitted, reason, action, operationId, extra = {}) => ({
  admitted,
  reason,
  action,
  operation_id: operationId,
  ...extra,
})

function common(evidence) {
  const operationId = t(evidence.operation_id)
  if (!operationId) return out(false, "malformed_evidence", "operation_id_is_required", "")

  const state = evidence.state ?? {}
  const route = evidence.continuity_route ?? {}
  const routeType = t(route.type)
  const action = evidence.requested_action ?? {}

  if (
    b(state.broad_operator_pause_requested) ||
    b(state.host_wide_shutdown_requested) ||
    b(action.pause_all_operator_work) ||
    b(action.restart_all_operator_surfaces)
  ) {
    return out(false, "broad_containment_rejected", "quarantine_only_the_affected_instruction_history_or_media_surface", operationId)
  }

  if (
    b(state.parent_task_replay_requested) ||
    b(state.completed_write_replay_requested) ||
    b(action.replay_completed_mutations) ||
    b(action.create_duplicate_task_before_reconciliation)
  ) {
    return out(false, "unsafe_replay_rejected", "preserve_the_canonical_operation_and_reconcile_completed_writes_before_continuing", operationId)
  }

  if (
    b(action.use_model_gateway) ||
    b(action.enable_automatic_model_selection) ||
    b(action.use_copilot_auto_selection) ||
    b(action.route_through_bedrock) ||
    b(action.route_through_vertex) ||
    b(action.use_excluded_provider)
  ) {
    return out(false, "prohibited_routing_rejected", "use_only_pinned_direct_openai_or_explicitly_authorized_local_routes", operationId)
  }

  if (routeType && !ROUTES.has(routeType)) {
    return out(false, "unapproved_continuity_route", "use_only_pinned_direct_openai_or_explicitly_authorized_local_routes", operationId)
  }

  if (
    b(route.model_gateway_present) ||
    b(route.automatic_model_selection_enabled) ||
    b(route.excluded_provider_dependency_present) ||
    b(route.copilot_auto_selection_present) ||
    b(route.bedrock_present) ||
    b(route.vertex_present)
  ) {
    return out(false, "route_authority_invalid", "remove_gateways_auto_selection_and_excluded_or_unapproved_provider_dependencies", operationId)
  }

  return { operationId, state, route, routeType, action }
}

const writesReady = (state) =>
  b(state.task_state_checkpointed) &&
  b(state.repository_writes_reconciled) &&
  b(state.connector_writes_reconciled) &&
  b(state.deployment_writes_reconciled) &&
  b(state.external_write_ledger_reconciled)

const routeReady = (route, routeType) =>
  ROUTES.has(routeType) &&
  b(route.verified) &&
  b(route.canary_passed) &&
  b(route.operation_binding_matches) &&
  b(route.pinned_openai_model) &&
  b(route.excluded_provider_dependency_absent) &&
  !b(route.model_gateway_present) &&
  !b(route.automatic_model_selection_enabled)

function evaluateInstructionBudget(evidence, base) {
  const { operationId, state, route, routeType, action } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const budget = n(observed.project_doc_max_bytes)
  const files = Array.isArray(observed.instruction_files) ? observed.instruction_files : []
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, n(file.bytes)), 0)
  const criticalFiles = files.filter((file) => b(file.critical)).map((file) => t(file.path)).filter(Boolean)
  const loaded = new Set((observed.loaded_instruction_files ?? []).map(t))
  const missingCritical = criticalFiles.filter((file) => !loaded.has(file))
  const affected =
    lower(observed.client) === "codex" &&
    (b(observed.instruction_chain_truncated) || totalBytes > budget || missingCritical.length > 0)

  if (!affected) {
    return out(true, "instruction_chain_within_verified_budget", "continue_normal_operation", operationId, {
      configured_budget_bytes: budget,
      observed_chain_bytes: totalBytes,
    })
  }

  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_the_task_and_reconcile_repository_connector_deployment_and_external_writes", operationId)
  }

  if (
    b(action.assume_project_doc_limit_is_per_file) ||
    b(action.split_files_without_recalculating_total_budget) ||
    b(action.continue_mutations_with_unverified_instruction_chain)
  ) {
    return out(false, "instruction_budget_semantics_rejected", "treat_project_doc_max_bytes_as_one_cumulative_root_to_cwd_budget", operationId)
  }

  if (
    !b(recovery.instruction_inventory_recorded) ||
    !b(recovery.file_sizes_and_hashes_recorded) ||
    !b(recovery.root_to_cwd_order_recorded) ||
    !b(recovery.critical_instruction_set_declared)
  ) {
    return out(false, "instruction_inventory_required", "record_the_root_to_cwd_instruction_inventory_sizes_hashes_and_critical_files", operationId)
  }

  if (
    totalBytes > budget &&
    !b(recovery.budget_raised_above_total_chain) &&
    !b(recovery.chain_compacted_below_budget)
  ) {
    return out(false, "instruction_chain_exceeds_cumulative_budget", "raise_the_cumulative_budget_or_compact_the_full_chain_before_mutating_work", operationId, {
      configured_budget_bytes: budget,
      observed_chain_bytes: totalBytes,
      missing_critical_files: missingCritical,
    })
  }

  if (
    !b(recovery.fresh_session_started_from_target_directory) ||
    !b(recovery.loaded_sources_canary_passed) ||
    !b(recovery.loaded_content_hashes_match_manifest) ||
    missingCritical.length > 0
  ) {
    return out(false, "instruction_authority_unverified", "start_a_fresh_session_and_verify_every_critical_instruction_source_and_hash_before_mutations", operationId, {
      missing_critical_files: missingCritical,
    })
  }

  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  return out(true, "instruction_budget_failure_contained", "continue_from_the_verified_instruction_manifest_without_replaying_completed_work", operationId, {
    configured_budget_bytes: budget,
    observed_chain_bytes: totalBytes,
    critical_instruction_files: criticalFiles,
    continuity_route: routeType,
  })
}

function evaluateRestoredRolloutBackfill(evidence, base) {
  const { operationId, state, route, routeType, action } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const restoredFiles = n(observed.restored_rollout_files)
  const indexedRows = n(observed.indexed_thread_rows)
  const affected =
    b(observed.backfill_marked_complete) &&
    b(observed.backfill_completed_while_rollout_inventory_empty) &&
    restoredFiles > indexedRows

  if (!affected) {
    return out(true, "rollout_index_inventory_consistent", "continue_normal_operation", operationId)
  }

  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_the_task_and_reconcile_repository_connector_deployment_and_external_writes", operationId)
  }

  if (
    b(action.edit_state_database) ||
    b(action.rearm_backfill_with_direct_sql) ||
    b(action.delete_state_database) ||
    b(action.move_live_rollout_files) ||
    b(action.replace_missing_threads_with_new_threads)
  ) {
    return out(false, "unsupported_state_repair_rejected", "preserve_the_database_and_rollouts_and_use_read_only_inventory_reconciliation", operationId)
  }

  if (
    !b(recovery.state_database_backup_created) ||
    !b(recovery.rollout_inventory_manifest_created) ||
    !b(recovery.rollout_hashes_verified) ||
    !b(recovery.active_and_archived_counts_recorded) ||
    !b(recovery.index_inventory_comparison_recorded)
  ) {
    return out(false, "recovery_manifest_required", "back_up_state_and_create_a_hash_bound_rollout_to_index_inventory_manifest", operationId)
  }

  if (
    !b(recovery.only_affected_history_resumption_withheld) ||
    !b(recovery.active_worktrees_and_external_writes_preserved) ||
    !b(recovery.recovery_manifest_bound_to_operation)
  ) {
    return out(false, "narrow_containment_required", "withhold_only_unindexed_history_resumption_while_active_verified_work_continues", operationId)
  }

  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  if (
    b(recovery.desktop_history_authority_restored) &&
    (!b(recovery.supported_reindex_or_fixed_build_used) ||
      !b(recovery.restored_file_count_matches_indexed_row_count) ||
      !b(recovery.random_thread_readback_canary_passed) ||
      !b(recovery.active_and_archived_visibility_canary_passed))
  ) {
    return out(false, "premature_history_authority_restore", "keep_desktop_history_non_authoritative_until_supported_reindex_and_inventory_canaries_pass", operationId)
  }

  return out(true, "restored_rollout_index_failure_contained", "continue_active_verified_operations_and_preserve_unindexed_history_for_supported_reconciliation", operationId, {
    restored_rollout_files: restoredFiles,
    indexed_thread_rows: indexedRows,
    continuity_route: routeType,
    desktop_history_authority_restored: b(recovery.desktop_history_authority_restored),
  })
}

function evaluateMacosImageSandbox(evidence, base) {
  const { operationId, state, route, routeType, action } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const affected =
    lower(observed.platform) === "macos" &&
    n(observed.fs_sandbox_signal) === 9 &&
    (b(observed.view_image_failed) || b(observed.image_gen_local_reference_failed))

  if (!affected) {
    return out(true, "local_image_sandbox_not_affected", "continue_normal_operation", operationId)
  }

  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_the_task_and_reconcile_repository_connector_deployment_and_external_writes", operationId)
  }

  if (
    b(action.disable_filesystem_sandbox) ||
    b(action.broaden_filesystem_permissions) ||
    b(action.disable_platform_security) ||
    b(action.repeat_path_copy_workarounds) ||
    b(action.retry_generation_without_identity_receipt)
  ) {
    return out(false, "unsafe_media_recovery_rejected", "preserve_the_sandbox_and_rebind_the_verified_image_through_a_direct_openai_or_canonical_attachment_route", operationId)
  }

  if (
    !b(recovery.source_file_exists) ||
    !b(recovery.source_sha256_recorded) ||
    !b(recovery.source_byte_count_recorded) ||
    !b(recovery.source_mime_and_dimensions_recorded) ||
    !b(recovery.source_decodes_with_authorized_local_tool)
  ) {
    return out(false, "media_identity_receipt_required", "record_hash_size_mime_dimensions_and_local_decode_receipts_before_rerouting", operationId)
  }

  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_direct_openai_image_api_or_canonical_attachment_route", operationId)
  }

  if (!["direct_openai_image_api", "canonical_chat_attachment"].includes(routeType)) {
    return out(false, "media_route_not_capable", "use_direct_openai_image_api_or_the_canonical_chat_attachment_surface_for_reference_image_rebinding", operationId)
  }

  if (
    !b(recovery.reference_rebound_to_existing_operation) ||
    !b(recovery.source_hash_bound_to_generation_request) ||
    !b(recovery.output_receipt_recorded) ||
    !b(recovery.only_local_path_media_surface_quarantined)
  ) {
    return out(false, "media_continuity_receipt_incomplete", "bind_the_verified_reference_and_output_receipts_to_the_existing_operation_without_task_replay", operationId)
  }

  if (
    b(recovery.local_path_media_authority_restored) &&
    (!b(recovery.workspace_view_image_canary_passed) ||
      !b(recovery.generated_image_read_canary_passed) ||
      !b(recovery.attachment_read_canary_passed) ||
      !b(recovery.image_to_image_reference_canary_passed))
  ) {
    return out(false, "premature_media_authority_restore", "keep_local_path_media_reads_quarantined_until_all_workspace_generated_attachment_and_image_to_image_canaries_pass", operationId)
  }

  return out(true, "macos_image_sandbox_failure_contained", "continue_the_existing_media_operation_through_the_verified_direct_route", operationId, {
    continuity_route: routeType,
    source_sha256: t(recovery.source_sha256),
    local_path_media_authority_restored: b(recovery.local_path_media_authority_restored),
  })
}

export function evaluate(evidence) {
  const base = common(evidence ?? {})
  if (Object.hasOwn(base, "admitted")) return base
  if (evidence.mode === "instruction_budget_integrity") return evaluateInstructionBudget(evidence, base)
  if (evidence.mode === "restored_rollout_backfill") return evaluateRestoredRolloutBackfill(evidence, base)
  if (evidence.mode === "macos_image_sandbox") return evaluateMacosImageSandbox(evidence, base)
  return out(false, "unsupported_mode", "use_a_supported_guidance_state_or_media_continuity_mode", base.operationId)
}

function run() {
  const index = process.argv.indexOf("--input")
  if (index < 0 || !process.argv[index + 1]) process.exit(2)
  const full = path.resolve(process.argv[index + 1])
  const stat = fs.lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink()) process.exit(2)
  const result = evaluate(JSON.parse(fs.readFileSync(full, "utf8")))
  ;(result.admitted ? process.stdout : process.stderr).write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.admitted ? 0 : 77)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
