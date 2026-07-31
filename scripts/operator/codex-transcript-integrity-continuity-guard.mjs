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
])

const t = (value) => String(value ?? "").trim()
const lower = (value) => t(value).toLowerCase()
const b = (value) => value === true
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
    return out(false, "broad_containment_rejected", "quarantine_only_decisions_and_mutations_that_depend_on_the_unverified_transcript_segment", operationId)
  }

  if (
    b(state.parent_task_replay_requested) ||
    b(state.completed_write_replay_requested) ||
    b(action.replay_completed_mutations) ||
    b(action.start_replacement_thread_before_reconciliation)
  ) {
    return out(false, "unsafe_replay_rejected", "preserve_the_canonical_thread_and_reconcile_completed_writes_before_continuing", operationId)
  }

  if (
    b(action.delete_session_state) ||
    b(action.edit_state_database) ||
    b(action.overwrite_rollout_file) ||
    b(action.trust_visible_transcript_as_authoritative)
  ) {
    return out(false, "destructive_or_unverified_recovery_rejected", "preserve_canonical_state_and_verify_persisted_message_content_before_action", operationId)
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

function evaluateTranscriptIntegrity(evidence, base) {
  const { operationId, state, route, routeType, action } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}

  const affected =
    ["codex_cli_tui", "codex_tui_resume", "codex_tui_scrollback"].includes(lower(observed.surface)) &&
    (
      b(observed.visible_assistant_content_missing) ||
      b(observed.prior_response_changed_after_reply) ||
      b(observed.content_reappeared_after_refresh) ||
      b(observed.visible_and_persisted_message_mismatch)
    )

  if (!affected) {
    return out(true, "transcript_rendering_not_affected", "continue_normal_operation", operationId)
  }

  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_the_task_and_reconcile_repository_connector_deployment_and_external_writes", operationId)
  }

  if (
    b(action.copy_visible_text_into_authoritative_memory) ||
    b(action.approve_based_only_on_scrollback) ||
    b(action.repeat_missing_work_without_receipt_check)
  ) {
    return out(false, "visible_transcript_authority_rejected", "bind_decisions_to_verified_persisted_message_items_and_content_hashes", operationId)
  }

  if (
    !b(recovery.exact_thread_id_verified) ||
    !b(recovery.exact_rollout_path_verified) ||
    !b(recovery.immutable_rollout_copy_created) ||
    !b(recovery.rollout_sha256_verified) ||
    !b(recovery.canonical_message_item_id_recorded) ||
    !b(recovery.canonical_message_hash_recorded)
  ) {
    return out(false, "canonical_receipt_required", "resolve_the_exact_thread_and_rollout_then_create_and_hash_an_immutable_receipt", operationId)
  }

  const canonicalPersistenceComplete =
    b(recovery.persisted_message_content_complete) &&
    (b(recovery.app_server_readback_matches_rollout) || b(recovery.canonical_rollout_parse_verified))

  if (!canonicalPersistenceComplete) {
    if (
      !b(recovery.only_dependent_mutations_withheld) ||
      !b(recovery.missing_segment_marked_unverified) ||
      !b(recovery.external_receipts_and_logs_preserved)
    ) {
      return out(false, "canonical_persistence_unverified", "withhold_only_dependent_mutations_and_reconstruct_from_preserved_receipts_without_replaying_completed_writes", operationId)
    }

    return out(false, "canonical_content_reconstruction_required", "reconcile_the_missing_message_against_external_receipts_and_resume_only_after_a_complete_canonical_receipt_exists", operationId, {
      affected_surface: lower(observed.surface),
      dependent_mutations_withheld: true,
    })
  }

  if (
    !b(recovery.decision_inputs_rebound_to_canonical_receipt) ||
    !b(recovery.session_continued_without_task_replay) ||
    !b(recovery.only_unverified_visible_segment_quarantined)
  ) {
    return out(false, "continuity_receipt_incomplete", "rebind_decisions_to_the_canonical_message_and_continue_the_existing_operation_without_replay", operationId)
  }

  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  if (
    b(recovery.tui_authority_restored) &&
    (!b(recovery.two_consecutive_full_render_canaries_passed) ||
      !b(recovery.copy_paste_scroll_canary_passed) ||
      !b(recovery.resume_replay_canary_passed) ||
      !b(recovery.rendered_hash_matches_canonical_hash))
  ) {
    return out(false, "premature_tui_authority_restore", "keep_the_tui_non_authoritative_until_render_copy_paste_scroll_and_resume_canaries_match_the_canonical_hash", operationId)
  }

  return out(true, "transcript_rendering_failure_contained", "continue_the_existing_operation_from_the_verified_canonical_receipt", operationId, {
    continuity_route: routeType,
    thread_id: t(recovery.thread_id),
    canonical_message_item_id: t(recovery.canonical_message_item_id),
    canonical_message_hash: t(recovery.canonical_message_hash),
    tui_authority_restored: b(recovery.tui_authority_restored),
  })
}

export function evaluate(evidence) {
  const base = common(evidence ?? {})
  if (Object.hasOwn(base, "admitted")) return base
  if (evidence.mode === "tui_transcript_integrity") return evaluateTranscriptIntegrity(evidence, base)
  return out(false, "unsupported_mode", "use_a_supported_transcript_integrity_mode", base.operationId)
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
