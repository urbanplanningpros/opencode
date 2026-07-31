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
  "approved_windows_native_openai",
])

const text = (value) => String(value ?? "").trim()
const lower = (value) => text(value).toLowerCase()
const yes = (value) => value === true
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
    yes(requested.replay_completed_mutations)
  ) {
    return result(false, "unsafe_broad_action", "quarantine_only_the_affected_fork_or_voice_bridge_and_reconcile_before_continuing", operationId)
  }

  if (
    yes(route.model_gateway_present) ||
    yes(route.automatic_model_selection_enabled) ||
    yes(route.copilot_auto_selection_present) ||
    yes(route.bedrock_present) ||
    yes(route.vertex_present) ||
    yes(route.excluded_provider_dependency_present)
  ) {
    return result(false, "route_authority_invalid", "remove_gateways_auto_selection_and_excluded_or_unapproved_provider_dependencies", operationId)
  }

  if (routeType && !APPROVED_ROUTES.has(routeType)) {
    return result(false, "unapproved_continuity_route", "use_only_pinned_direct_openai_or_explicitly_authorized_local_routes", operationId)
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

function evaluateFork(evidence, base) {
  const { operationId, route, routeType, requested } = base
  const source = evidence.source ?? {}
  const fork = evidence.fork ?? {}
  const recovery = evidence.recovery ?? {}
  const state = evidence.state ?? {}

  const sourceActive =
    yes(source.turn_in_progress) ||
    yes(source.active_tool_call_present) ||
    ["inprogress", "running", "waitingonapproval"].includes(lower(source.latest_turn_status))

  const contaminated =
    yes(fork.child_contains_source_active_turn) ||
    yes(fork.child_contains_partial_assistant_output) ||
    yes(fork.child_contains_running_tool_context) ||
    yes(fork.child_contains_abandoned_instruction) ||
    yes(fork.inherited_turn_id_matches_active_source_turn)

  if (!sourceActive && !contaminated) {
    if (
      yes(requested.create_native_fork) &&
      (!yes(source.completed_history_manifest_verified) ||
        !yes(fork.post_creation_child_inspection_required) ||
        !yes(fork.mutations_blocked_until_inspection))
    ) {
      return result(false, "fork_verification_required", "verify_the_completed_history_manifest_and_inspect_the_child_before_enabling_mutations", operationId)
    }

    return result(true, "fork_boundary_clean", "continue_with_post_creation_child_inspection", operationId)
  }

  if (yes(requested.create_native_fork) && sourceActive) {
    return result(false, "active_turn_fork_rejected", "checkpoint_or_terminally_resolve_the_source_turn_before_native_forking_or_use_a_verified_independent_thread_snapshot", operationId)
  }

  if (contaminated) {
    if (
      !yes(recovery.child_mutations_blocked) ||
      !yes(recovery.child_write_ledger_reconciled) ||
      !yes(recovery.contaminated_child_quarantined) ||
      !yes(recovery.duplicate_delegation_suppressed)
    ) {
      return result(false, "contaminated_child_containment_required", "block_child_mutations_reconcile_any_writes_quarantine_the_child_and_suppress_duplicate_delegation", operationId)
    }
  }

  const method = lower(recovery.continuity_method)
  const approvedMethod = new Set([
    "parent_executes_mutation",
    "new_independent_thread_from_verified_snapshot",
    "wait_for_source_terminal_then_native_fork",
  ])

  if (!approvedMethod.has(method)) {
    return result(false, "safe_continuity_method_required", "use_the_parent_or_a_new_independent_thread_seeded_only_from_verified_completed_history", operationId)
  }

  if (method === "new_independent_thread_from_verified_snapshot") {
    if (
      !yes(recovery.completed_history_snapshot_verified) ||
      !text(recovery.completed_history_sha256) ||
      !yes(recovery.active_source_turn_excluded) ||
      !yes(recovery.idempotency_registry_checked) ||
      !yes(recovery.new_thread_mutations_blocked_until_inspection) ||
      !yes(recovery.no_source_active_turn_ids_present)
    ) {
      return result(false, "independent_thread_snapshot_incomplete", "verify_and_hash_completed_history_exclude_the_active_turn_check_idempotency_and_inspect_before_mutation", operationId)
    }
  }

  if (method === "wait_for_source_terminal_then_native_fork") {
    if (
      !yes(recovery.source_turn_terminal_receipt_verified) ||
      !yes(recovery.no_live_source_tool_calls) ||
      !yes(recovery.post_fork_child_boundary_verified)
    ) {
      return result(false, "terminal_fork_receipt_incomplete", "verify_the_source_terminal_receipt_no_live_tool_calls_and_the_child_fork_boundary", operationId)
    }
  }

  if (!stateReconciled(state)) {
    return result(false, "state_reconciliation_required", "reconcile_repository_connector_deployment_and_external_writes_before_continuation", operationId)
  }

  if (!routeReady(route, routeType)) {
    return result(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  return result(true, "active_fork_contained", "continue_without_inheriting_or_replaying_the_unfinished_source_turn", operationId, {
    continuity_method: method,
    continuity_route: routeType,
    contaminated_child_quarantined: contaminated,
  })
}

function evaluateVoiceBridge(evidence, base) {
  const { operationId, route, routeType, requested } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const state = evidence.state ?? {}

  const affected =
    yes(observed.no_handler_registered) ||
    yes(observed.thread_list_unavailable) ||
    yes(observed.generic_tool_error_after_successful_delegation) ||
    yes(observed.live_host_route_lost) ||
    yes(observed.agent_task_tool_timeout_while_local_app_server_healthy)

  if (!affected) {
    return result(true, "voice_bridge_healthy", "continue_normal_operation", operationId)
  }

  if (
    yes(requested.retry_create_thread_without_registry_readback) ||
    yes(requested.retry_side_effecting_voice_tool) ||
    yes(requested.treat_cached_task_rows_as_live_host_proof)
  ) {
    return result(false, "unsafe_voice_retry_rejected", "read_the_exact_task_registry_and_reconcile_side_effects_before_any_retry", operationId)
  }

  if (!stateReconciled(state)) {
    return result(false, "state_reconciliation_required", "reconcile_repository_connector_deployment_and_external_writes_before_rerouting", operationId)
  }

  if (
    !yes(recovery.voice_mutation_tools_disabled) ||
    !yes(recovery.exact_thread_uuid_registry_readback_complete) ||
    !yes(recovery.side_effecting_retry_suppressed) ||
    !yes(recovery.existing_child_status_reconciled) ||
    !yes(recovery.operation_id_and_idempotency_key_preserved)
  ) {
    return result(false, "voice_bridge_containment_required", "disable_voice_mutations_read_back_exact_thread_uuids_reconcile_children_and_preserve_idempotency", operationId)
  }

  if (!routeReady(route, routeType)) {
    return result(false, "continuity_route_unverified", "continue_the_unfinished_operation_through_a_verified_direct_openai_or_authorized_local_route", operationId)
  }

  if (yes(recovery.voice_mutation_authority_restored)) {
    if (
      !yes(recovery.three_consecutive_handler_canaries_passed) ||
      !yes(recovery.create_read_wait_message_fork_canary_passed) ||
      !yes(recovery.no_duplicate_thread_canary_passed) ||
      !yes(recovery.host_route_survived_child_completion_and_timeout)
    ) {
      return result(false, "premature_voice_authority_restore", "keep_voice_read_only_until_handler_route_and_idempotency_canaries_pass", operationId)
    }
  }

  return result(true, "voice_bridge_failure_contained", "continue_through_the_verified_route_with_voice_limited_to_read_only_narration", operationId, {
    continuity_route: routeType,
    voice_read_only: true,
    voice_mutation_authority_restored: yes(recovery.voice_mutation_authority_restored),
  })
}

export function evaluate(evidence) {
  const base = validateCommon(evidence ?? {})
  if (Object.hasOwn(base, "admitted")) return base

  if (evidence.mode === "active_fork_boundary") return evaluateFork(evidence, base)
  if (evidence.mode === "realtime_voice_task_bridge") return evaluateVoiceBridge(evidence, base)

  return result(false, "unsupported_mode", "use_active_fork_boundary_or_realtime_voice_task_bridge", base.operationId)
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
