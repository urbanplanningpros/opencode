#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const APPROVED_ROUTES = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_ssh_remote_openai",
])

const text = (value) => String(value ?? "").trim()
const lower = (value) => text(value).toLowerCase()
const yes = (value) => value === true
const nonEmptyArray = (value) => Array.isArray(value) && value.length > 0
const result = (admitted, reason, action, operationId, extra = {}) => ({
  admitted,
  reason,
  action,
  operation_id: operationId,
  ...extra,
})

function validateCommon(evidence) {
  const operationId = text(evidence.operation_id)
  if (!operationId) return result(false, "malformed_evidence", "operation_id_is_required", "")

  const route = evidence.continuity_route ?? {}
  const routeType = text(route.type)
  const requested = evidence.requested_action ?? {}

  if (
    yes(requested.pause_all_operations) ||
    yes(requested.restart_all_operator_surfaces) ||
    yes(requested.replay_parent_task) ||
    yes(requested.replay_completed_mutations) ||
    yes(requested.delete_thread_state) ||
    yes(requested.disable_all_schedules)
  ) {
    return result(
      false,
      "unsafe_broad_action",
      "quarantine_only_the_affected_task_bridge_or_child_and_reconcile_before_continuing",
      operationId,
    )
  }

  if (
    yes(route.model_gateway_present) ||
    yes(route.automatic_model_selection_enabled) ||
    yes(route.copilot_auto_selection_present) ||
    yes(route.bedrock_present) ||
    yes(route.vertex_present) ||
    yes(route.excluded_provider_dependency_present)
  ) {
    return result(
      false,
      "route_authority_invalid",
      "remove_gateways_auto_selection_and_excluded_or_unapproved_provider_dependencies",
      operationId,
    )
  }

  if (routeType && !APPROVED_ROUTES.has(routeType)) {
    return result(
      false,
      "unapproved_continuity_route",
      "use_only_pinned_direct_openai_or_explicitly_authorized_local_routes",
      operationId,
    )
  }

  return { operationId, route, routeType, requested }
}

const routeReady = (route, routeType) =>
  APPROVED_ROUTES.has(routeType) &&
  yes(route.verified) &&
  yes(route.canary_passed) &&
  yes(route.operation_binding_matches) &&
  yes(route.pinned_openai_model) &&
  yes(route.excluded_provider_dependency_absent) &&
  !yes(route.model_gateway_present) &&
  !yes(route.automatic_model_selection_enabled)

const stateReconciled = (state) =>
  yes(state.repository_writes_reconciled) &&
  yes(state.connector_writes_reconciled) &&
  yes(state.deployment_writes_reconciled) &&
  yes(state.external_write_ledger_reconciled)

function evaluateScheduledBackground(evidence, base) {
  const { operationId, route, routeType, requested } = base
  const observed = evidence.observed ?? {}
  const identity = evidence.identity ?? {}
  const recovery = evidence.recovery ?? {}
  const state = evidence.state ?? {}

  const stalled =
    yes(observed.scheduled_task_active) &&
    yes(observed.app_owned_tool_requested) &&
    yes(observed.tool_start_missing) &&
    yes(observed.no_visible_error_or_approval) &&
    (yes(observed.foreground_open_triggered_resume) || yes(observed.thread_resume_immediately_started_tool))

  if (!stalled) {
    return result(true, "scheduled_background_path_healthy", "continue_normal_operation", operationId)
  }

  if (
    yes(requested.create_replacement_schedule) ||
    yes(requested.start_duplicate_task) ||
    yes(requested.replay_full_scheduled_turn) ||
    yes(requested.mark_complete_without_terminal_receipt)
  ) {
    return result(
      false,
      "unsafe_scheduled_retry_rejected",
      "preserve_the_existing_task_and_wake_or_reroute_only_the_unfinished_tool_segment",
      operationId,
    )
  }

  if (
    !text(identity.schedule_id) ||
    !text(identity.thread_id) ||
    !text(identity.turn_id) ||
    !text(identity.tool_call_id) ||
    !text(identity.schedule_definition_sha256) ||
    !text(identity.task_prompt_sha256)
  ) {
    return result(
      false,
      "scheduled_identity_receipt_required",
      "record_schedule_thread_turn_tool_and_prompt_identity_before_recovery",
      operationId,
    )
  }

  if (!stateReconciled(state)) {
    return result(
      false,
      "state_reconciliation_required",
      "reconcile_repository_connector_deployment_and_external_writes_before_waking_or_routing",
      operationId,
    )
  }

  if (
    !yes(recovery.duplicate_wake_suppressed) ||
    !yes(recovery.side_effect_status_read_back) ||
    !yes(recovery.same_thread_resume_attempted) ||
    !yes(recovery.operation_id_preserved) ||
    !yes(recovery.idempotency_key_preserved) ||
    !yes(recovery.only_unfinished_tool_segment_authorized)
  ) {
    return result(
      false,
      "scheduled_containment_required",
      "read_back_side_effect_state_suppress_duplicate_wakes_and_resume_the_same_task_before_any_reroute",
      operationId,
    )
  }

  const method = lower(recovery.continuity_method)
  const approvedMethods = new Set([
    "same_thread_resume",
    "direct_app_server_tool_resume",
    "bounded_equivalent_tool_reroute",
    "defer_only_unavailable_tool_segment",
  ])

  if (!approvedMethods.has(method)) {
    return result(
      false,
      "safe_scheduled_continuity_method_required",
      "use_same_thread_resume_direct_app_server_resume_or_a_bounded_equivalent_approved_tool_route",
      operationId,
    )
  }

  if (method === "bounded_equivalent_tool_reroute") {
    if (
      !yes(recovery.original_tool_confirmed_not_started) ||
      !yes(recovery.equivalent_tool_semantics_verified) ||
      !yes(recovery.output_receipt_bound_to_original_tool_call) ||
      !nonEmptyArray(recovery.allowed_side_effects) ||
      !yes(recovery.side_effect_scope_matches_original)
    ) {
      return result(
        false,
        "bounded_tool_reroute_incomplete",
        "verify_nonexecution_equivalent_semantics_allowed_side_effects_and_bind_the_receipt_to_the_original_tool_call",
        operationId,
      )
    }
  }

  if (method === "defer_only_unavailable_tool_segment") {
    if (
      !yes(recovery.non_tool_work_checkpointed) ||
      !yes(recovery.task_remains_registered) ||
      !yes(recovery.resume_condition_recorded) ||
      !yes(recovery.unrelated_schedules_continue)
    ) {
      return result(
        false,
        "segment_deferral_receipt_incomplete",
        "checkpoint_completed_work_record_the_resume_condition_and_keep_unrelated_schedules_running",
        operationId,
      )
    }
  }

  if (!routeReady(route, routeType)) {
    return result(
      false,
      "continuity_route_unverified",
      "verify_a_pinned_approved_openai_or_authorized_local_route",
      operationId,
    )
  }

  if (yes(recovery.background_authority_restored)) {
    if (
      !yes(recovery.three_consecutive_background_canaries_passed) ||
      !yes(recovery.canaries_completed_without_opening_thread) ||
      !yes(recovery.tool_dispatch_started_within_deadline) ||
      !yes(recovery.terminal_receipts_persisted) ||
      !yes(recovery.no_duplicate_wakes_observed)
    ) {
      return result(
        false,
        "premature_background_authority_restore",
        "keep_the_affected_background_tool_path_under_guard_until_unattended_canaries_pass",
        operationId,
      )
    }
  }

  return result(
    true,
    "scheduled_background_stall_contained",
    "continue_the_existing_schedule_through_the_verified_wake_or_bounded_reroute_without_replaying_completed_work",
    operationId,
    {
      continuity_method: method,
      continuity_route: routeType,
      background_authority_restored: yes(recovery.background_authority_restored),
    },
  )
}

function evaluateRemoteHostAffinity(evidence, base) {
  const { operationId, route, routeType, requested } = base
  const observed = evidence.observed ?? {}
  const expected = evidence.expected_destination ?? {}
  const actual = evidence.actual_destination ?? {}
  const recovery = evidence.recovery ?? {}
  const state = evidence.state ?? {}

  const threadBridgeFailure =
    yes(observed.project_scoped_create_hung) ||
    yes(observed.thread_management_calls_hung) ||
    yes(observed.no_structured_timeout_or_result)

  const semanticDrift =
    yes(observed.project_target_replaced_with_projectless) ||
    yes(observed.project_identity_lost) ||
    yes(observed.host_affinity_lost) ||
    yes(observed.child_created_on_wrong_host)

  if (!threadBridgeFailure && !semanticDrift) {
    if (yes(requested.enable_child_mutations)) {
      if (
        !yes(recovery.child_destination_verified) ||
        !yes(recovery.project_identity_verified) ||
        !yes(recovery.worktree_identity_verified) ||
        !yes(recovery.starting_commit_verified)
      ) {
        return result(
          false,
          "destination_preflight_required",
          "verify_host_project_worktree_and_starting_commit_before_child_mutations",
          operationId,
        )
      }
    }
    return result(true, "remote_project_route_healthy", "continue_normal_operation", operationId)
  }

  if (
    yes(requested.fallback_to_projectless_for_repository_work) ||
    yes(requested.retry_create_without_idempotency) ||
    yes(requested.accept_local_host_for_remote_repository) ||
    yes(requested.enable_child_mutations_before_destination_validation)
  ) {
    return result(
      false,
      "unsafe_host_fallback_rejected",
      "preserve_project_semantics_host_affinity_and_idempotency_and_validate_the_destination_before_mutation",
      operationId,
    )
  }

  if (
    !text(expected.project_id) ||
    !text(expected.host_id) ||
    !text(expected.canonical_worktree) ||
    !text(expected.starting_commit_sha) ||
    !text(expected.idempotency_key)
  ) {
    return result(
      false,
      "expected_destination_manifest_required",
      "record_the_exact_project_host_worktree_commit_and_idempotency_key_before_recovery",
      operationId,
    )
  }

  if (!stateReconciled(state)) {
    return result(
      false,
      "state_reconciliation_required",
      "reconcile_repository_connector_deployment_and_external_writes_before_retry_or_reroute",
      operationId,
    )
  }

  if (
    !yes(recovery.side_effect_unknown_state_resolved) ||
    !yes(recovery.exact_task_registry_readback_complete) ||
    !yes(recovery.duplicate_creation_suppressed) ||
    !yes(recovery.child_mutations_blocked_until_validation) ||
    !yes(recovery.operation_id_and_idempotency_key_preserved)
  ) {
    return result(
      false,
      "host_affinity_containment_required",
      "resolve_unknown_side_effects_read_back_the_task_registry_suppress_duplicates_and_block_child_mutations",
      operationId,
    )
  }

  const wrongDestination =
    (text(actual.host_id) && text(actual.host_id) !== text(expected.host_id)) ||
    (text(actual.project_id) && text(actual.project_id) !== text(expected.project_id)) ||
    (text(actual.canonical_worktree) && text(actual.canonical_worktree) !== text(expected.canonical_worktree)) ||
    yes(observed.child_created_on_wrong_host) ||
    yes(observed.project_identity_lost)

  if (wrongDestination) {
    if (
      !yes(recovery.wrong_destination_child_quarantined) ||
      !yes(recovery.wrong_destination_writes_reconciled) ||
      !yes(recovery.wrong_destination_child_cancelled_or_read_only) ||
      !yes(recovery.projectless_retry_disabled)
    ) {
      return result(
        false,
        "wrong_destination_quarantine_required",
        "quarantine_the_wrong_destination_child_reconcile_any_writes_and_disable_projectless_repository_retries",
        operationId,
      )
    }
  }

  const method = lower(recovery.continuity_method)
  const approvedMethods = new Set([
    "verified_parent_executes",
    "explicit_project_scoped_retry",
    "direct_remote_app_server",
    "approved_remote_cli",
  ])

  if (!approvedMethods.has(method)) {
    return result(
      false,
      "safe_host_continuity_method_required",
      "use_the_verified_parent_or_an_explicit_project_scoped_remote_route_never_projectless_for_repository_work",
      operationId,
    )
  }

  if (method === "explicit_project_scoped_retry") {
    if (
      !yes(recovery.previous_request_confirmed_terminal_or_absent) ||
      !yes(recovery.explicit_project_id_used) ||
      !yes(recovery.explicit_host_id_used) ||
      !yes(recovery.exact_worktree_used) ||
      !yes(recovery.child_destination_verified) ||
      !yes(recovery.project_identity_verified) ||
      !yes(recovery.worktree_identity_verified) ||
      !yes(recovery.starting_commit_verified)
    ) {
      return result(
        false,
        "project_scoped_retry_incomplete",
        "confirm_the_prior_request_state_then_use_and_verify_the_exact_project_host_worktree_and_commit",
        operationId,
      )
    }
  }

  if (["direct_remote_app_server", "approved_remote_cli"].includes(method)) {
    if (
      !yes(recovery.route_executes_on_expected_host) ||
      !yes(recovery.route_uses_expected_worktree) ||
      !yes(recovery.route_starting_commit_matches) ||
      !yes(recovery.output_reconciled_to_original_operation)
    ) {
      return result(
        false,
        "remote_route_binding_incomplete",
        "bind_the_route_to_the_expected_host_worktree_commit_and_original_operation_ledger",
        operationId,
      )
    }
  }

  if (!routeReady(route, routeType)) {
    return result(
      false,
      "continuity_route_unverified",
      "verify_a_pinned_approved_openai_or_explicitly_authorized_remote_route",
      operationId,
    )
  }

  if (yes(recovery.thread_bridge_authority_restored)) {
    if (
      !yes(recovery.three_consecutive_project_create_canaries_passed) ||
      !yes(recovery.structured_timeout_canary_passed) ||
      !yes(recovery.idempotent_retry_canary_passed) ||
      !yes(recovery.host_project_worktree_receipts_match) ||
      !yes(recovery.projectless_repository_fallback_rejected_by_host)
    ) {
      return result(
        false,
        "premature_thread_bridge_restore",
        "keep_project_creation_under_guard_until_liveness_idempotency_and_destination_canaries_pass",
        operationId,
      )
    }
  }

  return result(
    true,
    "remote_host_affinity_failure_contained",
    "continue_on_the_verified_project_bound_remote_route_without_semantic_fallback_or_duplicate_creation",
    operationId,
    {
      continuity_method: method,
      continuity_route: routeType,
      wrong_destination_quarantined: wrongDestination,
      thread_bridge_authority_restored: yes(recovery.thread_bridge_authority_restored),
    },
  )
}

export function evaluate(evidence) {
  const normalized = evidence ?? {}
  const base = validateCommon(normalized)
  if (Object.hasOwn(base, "admitted")) return base

  if (normalized.mode === "scheduled_background_tool_continuity") {
    return evaluateScheduledBackground(normalized, base)
  }
  if (normalized.mode === "remote_project_host_affinity") {
    return evaluateRemoteHostAffinity(normalized, base)
  }

  return result(
    false,
    "unsupported_mode",
    "use_scheduled_background_tool_continuity_or_remote_project_host_affinity",
    base.operationId,
  )
}

function run() {
  const index = process.argv.indexOf("--input")
  if (index < 0 || !process.argv[index + 1]) process.exit(2)
  const input = path.resolve(process.argv[index + 1])
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) process.exit(2)
  const evaluated = evaluate(JSON.parse(fs.readFileSync(input, "utf8")))
  ;(evaluated.admitted ? process.stdout : process.stderr).write(`${JSON.stringify(evaluated, null, 2)}\n`)
  process.exit(evaluated.admitted ? 0 : 77)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
