#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const APPROVED_ROUTES = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_linux_openai",
])

function bool(value) {
  return value === true
}

function text(value) {
  return String(value ?? "").trim()
}

function result(admitted, reason, action, operationId, extra = {}) {
  return {
    admitted,
    reason,
    action,
    operation_id: operationId,
    ...extra,
  }
}

function validateCommon(evidence) {
  const operationId = text(evidence.operation_id)
  if (!operationId) {
    return result(false, "malformed_evidence", "operation_id_is_required", "")
  }

  const state = evidence.state ?? {}
  if (bool(state.broad_operator_pause_requested) || bool(state.broad_host_shutdown_requested)) {
    return result(
      false,
      "broad_recovery_rejected",
      "quarantine_only_the_affected_thread_subagent_or_usage_path",
      operationId,
    )
  }
  if (bool(state.parent_task_replay_requested) || bool(state.completed_write_replay_requested)) {
    return result(
      false,
      "unsafe_replay_rejected",
      "preserve_the_canonical_operation_and_reconcile_writes_before_retry",
      operationId,
    )
  }

  const route = evidence.continuity_route ?? {}
  const routeType = text(route.type)
  if (routeType && !APPROVED_ROUTES.has(routeType)) {
    return result(
      false,
      "unapproved_continuity_route",
      "use_only_direct_openai_or_explicitly_authorized_local_routes",
      operationId,
    )
  }

  return { operationId, route, routeType, state }
}

function routeReady(route, routeType) {
  return (
    APPROVED_ROUTES.has(routeType) &&
    bool(route.verified) &&
    bool(route.canary_passed) &&
    bool(route.operation_binding_matches) &&
    bool(route.workspace_state_verified) &&
    bool(route.pinned_openai_model) &&
    bool(route.automatic_model_selection_disabled) &&
    bool(route.prohibited_dependency_absent)
  )
}

function writesReconciled(state) {
  return (
    bool(state.task_state_checkpointed) &&
    bool(state.repository_writes_reconciled) &&
    bool(state.connector_writes_reconciled) &&
    bool(state.deployment_writes_reconciled)
  )
}

function evaluateThreadCreate(evidence, common) {
  const { operationId, route, routeType, state } = common
  const request = evidence.request ?? {}
  const observed = evidence.observed ?? {}
  const reconciliation = evidence.reconciliation ?? {}
  const action = evidence.requested_action ?? {}

  if (!text(request.idempotency_key) || !text(request.fingerprint)) {
    return result(
      false,
      "thread_create_identity_missing",
      "bind_the_request_to_an_idempotency_key_and_canonical_fingerprint",
      operationId,
    )
  }
  if (!bool(request.model_pinned) || bool(request.automatic_model_selection_enabled)) {
    return result(
      false,
      "thread_create_model_authority_invalid",
      "pin_the_approved_model_and_disable_automatic_model_selection",
      operationId,
    )
  }

  const opaqueInvalidArguments =
    text(observed.status) === "invalid_arguments" &&
    !text(observed.field_name) &&
    !text(observed.thread_id) &&
    !text(observed.client_thread_id)

  if (!opaqueInvalidArguments) {
    return result(
      true,
      "thread_create_no_opaque_validation_failure",
      "continue_with_normal_exactly_once_thread_creation_controls",
      operationId,
    )
  }

  const reconciled =
    bool(reconciliation.list_threads_checked) &&
    bool(reconciliation.worktree_inventory_checked) &&
    bool(reconciliation.project_registry_checked) &&
    bool(reconciliation.repository_head_recorded) &&
    bool(reconciliation.working_tree_recorded) &&
    bool(reconciliation.no_new_thread_confirmed) &&
    bool(reconciliation.no_new_worktree_confirmed)

  if (!reconciled || !writesReconciled(state)) {
    return result(
      false,
      "thread_create_reconciliation_required",
      "reconcile_thread_project_worktree_and_write_state_before_any_retry_or_fallback",
      operationId,
    )
  }

  if (bool(action.retry_desktop_create_thread)) {
    return result(
      false,
      "opaque_thread_create_retry_suppressed",
      "do_not_blindly_replay_the_same_opaque_desktop_request",
      operationId,
    )
  }

  if (bool(action.continue_with_explicit_worktree)) {
    const worktree = evidence.explicit_worktree ?? {}
    const ready =
      routeReady(route, routeType) &&
      bool(worktree.created_once) &&
      bool(worktree.branch_identity_verified) &&
      bool(worktree.worktree_list_verified) &&
      bool(worktree.repository_head_verified) &&
      bool(worktree.working_tree_verified) &&
      bool(worktree.operation_receipt_written)

    if (!ready) {
      return result(
        false,
        "explicit_worktree_fallback_unverified",
        "require_a_verified_approved_route_and_exactly_once_git_worktree_receipts",
        operationId,
      )
    }

    return result(
      true,
      "thread_create_failure_contained",
      "continue_the_unfinished_build_in_the_verified_explicit_worktree_without_replaying_desktop_creation",
      operationId,
      { continuity_route: routeType },
    )
  }

  return result(
    false,
    "thread_create_path_quarantined",
    "continue_independent_work_but_withhold_new_desktop_worktree_threads_until_a_typed_fix_or_verified_fallback_is_selected",
    operationId,
  )
}

function evaluateSubagentObservability(evidence, common) {
  const { operationId, state } = common
  const child = evidence.child ?? {}
  const ui = evidence.ui ?? {}
  const action = evidence.requested_action ?? {}

  const childCreated = bool(child.created_receipt_present) && text(child.thread_id)
  const panelMissing = childCreated && !bool(ui.subagents_panel_visible)

  if (!panelMissing) {
    return result(
      true,
      "subagent_observability_healthy",
      "continue_with_operation_bound_child_status_tracking",
      operationId,
    )
  }

  if (bool(action.spawn_additional_subagent)) {
    return result(
      false,
      "additional_subagent_spawn_suppressed",
      "do_not_duplicate_delegation_while_an_existing_child_is_live_but_hidden",
      operationId,
      { child_thread_id: text(child.thread_id) },
    )
  }

  const terminal = ["completed", "failed", "cancelled"].includes(text(child.status))
  if (bool(action.complete_parent) && !terminal) {
    return result(
      false,
      "parent_completion_blocked_by_unreconciled_child",
      "obtain_a_terminal_child_receipt_before_parent_completion",
      operationId,
      { child_thread_id: text(child.thread_id), child_status: text(child.status) || "unknown" },
    )
  }

  const directReadback =
    bool(child.status_readback_available) &&
    bool(child.status_readback_operation_bound) &&
    bool(child.thread_identity_verified)

  if (!directReadback) {
    return result(
      false,
      "subagent_control_surface_unavailable",
      "quarantine_only_new_delegation_and_continue_safe_parent_work_until_exact_child_status_is_readable",
      operationId,
      { child_thread_id: text(child.thread_id) },
    )
  }

  if (!writesReconciled(state)) {
    return result(
      false,
      "subagent_write_reconciliation_required",
      "reconcile_child_repository_connector_and_deployment_writes_before_follow_up_actions",
      operationId,
      { child_thread_id: text(child.thread_id) },
    )
  }

  return result(
    true,
    "hidden_subagent_contained",
    "treat_the_panel_as_non_authoritative_and_control_the_exact_child_through_verified_status_readback",
    operationId,
    { child_thread_id: text(child.thread_id), child_status: text(child.status) || "unknown" },
  )
}

function evaluateUsageWindow(evidence, common) {
  const { operationId, route, routeType, state } = common
  const window = evidence.window ?? {}
  const action = evidence.requested_action ?? {}

  const resetAnchorChanged = bool(window.unexpected_reset_anchor_change)
  const pastDueStillAccumulating = bool(window.past_due_window_still_accumulating)
  const partialReset =
    bool(window.reset_credit_consumed) &&
    Number.isFinite(Number(window.capacity_ratio_to_prior)) &&
    Number(window.capacity_ratio_to_prior) < 0.75
  const anomaly = resetAnchorChanged || pastDueStillAccumulating || partialReset

  if (!anomaly) {
    return result(
      true,
      "usage_window_readings_stable",
      "continue_with_normal_budget_and_checkpoint_controls",
      operationId,
    )
  }

  const evidenceBound =
    text(window.plan_type) &&
    Number.isFinite(Number(window.window_minutes)) &&
    text(window.resets_at) &&
    Number.isFinite(Number(window.used_percent)) &&
    bool(window.telemetry_snapshot_preserved)

  if (!evidenceBound) {
    return result(
      false,
      "usage_window_evidence_incomplete",
      "preserve_plan_window_reset_usage_and_credit_receipts_before_rerouting",
      operationId,
    )
  }

  if (bool(action.start_new_unbounded_subscription_job)) {
    return result(
      false,
      "unbounded_subscription_job_suppressed",
      "queue_only_the_new_high_cost_job_until_capacity_is_verified_or_run_it_with_an_approved_bounded_route",
      operationId,
    )
  }

  const boundedContinuity =
    routeReady(route, routeType) &&
    writesReconciled(state) &&
    bool(action.essential_work_only) &&
    bool(action.token_budget_cap_set) &&
    bool(action.checkpoint_interval_set) &&
    bool(action.usage_readback_after_each_checkpoint)

  if (!boundedContinuity) {
    return result(
      false,
      "usage_window_continuity_unverified",
      "preserve_state_and_continue_only_essential_work_through_a_verified_budget_capped_approved_route",
      operationId,
    )
  }

  if (bool(action.restore_subscription_heavy_queue)) {
    const stable =
      bool(window.official_correction_identified) &&
      bool(window.two_consecutive_stable_readings) &&
      bool(window.post_reset_capacity_canary_passed)
    if (!stable) {
      return result(
        false,
        "subscription_heavy_queue_restore_blocked",
        "keep_only_the_high_cost_subscription_queue_deferred_until_stable_post_fix_canaries_pass",
        operationId,
      )
    }
  }

  return result(
    true,
    "usage_window_anomaly_contained",
    "continue_essential_work_with_bounded_checkpoints_and_verified_usage_readback",
    operationId,
    { continuity_route: routeType },
  )
}

export function evaluate(evidence) {
  const common = validateCommon(evidence ?? {})
  if (Object.hasOwn(common, "admitted")) return common

  const mode = text(evidence.mode)
  if (mode === "thread_create") return evaluateThreadCreate(evidence, common)
  if (mode === "subagent_observability") return evaluateSubagentObservability(evidence, common)
  if (mode === "usage_window") return evaluateUsageWindow(evidence, common)

  return result(
    false,
    "unsupported_mode",
    "mode_must_be_thread_create_subagent_observability_or_usage_window",
    common.operationId,
  )
}

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      index += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function readEvidence(file) {
  const full = path.resolve(file)
  const stat = fs.lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("input must be a regular non-symlink file")
  }
  return JSON.parse(fs.readFileSync(full, "utf8"))
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input) {
    process.stderr.write(`${JSON.stringify(result(false, "missing_input", "provide_evidence_json", ""), null, 2)}\n`)
    process.exit(2)
  }

  let evidence
  try {
    evidence = readEvidence(String(args.input))
  } catch (error) {
    process.stderr.write(`${JSON.stringify(result(false, "invalid_evidence", error.message, ""), null, 2)}\n`)
    process.exit(2)
  }

  const outcome = evaluate(evidence)
  const stream = outcome.admitted ? process.stdout : process.stderr
  stream.write(`${JSON.stringify(outcome, null, 2)}\n`)
  process.exit(outcome.admitted ? 0 : 77)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
}
