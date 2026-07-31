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
const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)
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

  if (b(state.broad_operator_pause_requested) || b(state.host_wide_shutdown_requested)) {
    return out(false, "broad_containment_rejected", "quarantine_only_the_affected_execution_surface", operationId)
  }
  if (b(state.parent_task_replay_requested) || b(state.completed_write_replay_requested)) {
    return out(false, "unsafe_replay_rejected", "preserve_the_canonical_operation_and_reconcile_completed_writes", operationId)
  }
  if (routeType && !ROUTES.has(routeType)) {
    return out(false, "unapproved_continuity_route", "use_only_pinned_direct_openai_or_explicitly_authorized_local_routes", operationId)
  }
  if (b(route.model_gateway_present) || b(route.automatic_model_selection_enabled) || b(route.excluded_provider_dependency_present)) {
    return out(false, "route_authority_invalid", "remove_gateways_auto_selection_and_excluded_provider_dependencies", operationId)
  }

  return { operationId, state, route, routeType }
}

const writesReady = (state) =>
  b(state.task_state_checkpointed) &&
  b(state.repository_writes_reconciled) &&
  b(state.connector_writes_reconciled) &&
  b(state.deployment_writes_reconciled)

const routeReady = (route, routeType) =>
  ROUTES.has(routeType) &&
  b(route.verified) &&
  b(route.canary_passed) &&
  b(route.operation_binding_matches) &&
  b(route.pinned_openai_model) &&
  b(route.excluded_provider_dependency_absent)

function evaluateRemoteLifecycle(evidence, base) {
  const { operationId, state, route, routeType } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const action = evidence.requested_action ?? {}

  const zombieCount = n(observed.zombie_count) ?? 0
  const childCount = n(observed.child_process_count) ?? 0
  const fdCount = n(observed.open_file_descriptor_count) ?? 0
  const affected =
    lower(observed.surface) === "ssh_remote_app_server" &&
    (zombieCount >= 100 || childCount >= 1000 || fdCount >= 10000 || b(observed.unbounded_git_spawn_loop))

  if (!affected) return out(true, "remote_process_lifecycle_not_affected", "continue_normal_remote_operation", operationId)

  if (b(action.kill_all_codex_processes) || b(action.kill_by_process_name) || b(action.restart_host) || b(action.replay_parent_task)) {
    return out(false, "unsafe_remote_recovery", "contain_only_the_owned_remote_app_server_and_preserve_task_state", operationId)
  }
  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_task_and_reconcile_repository_connector_and_deployment_writes", operationId)
  }
  if (
    !b(recovery.exact_app_server_identity_verified) ||
    !b(recovery.process_tree_ownership_verified) ||
    !b(recovery.pre_restart_process_inventory_recorded) ||
    !b(recovery.pre_restart_repository_receipt_recorded)
  ) {
    return out(false, "remote_process_ownership_unverified", "identify_the_exact_app_server_and_record_process_and_repository_receipts", operationId)
  }
  if (!b(recovery.only_affected_app_server_restarted) && !b(recovery.only_affected_container_restarted)) {
    return out(false, "narrow_restart_required", "restart_only_the_owned_remote_app_server_or_its_dedicated_container", operationId)
  }
  if (
    !b(recovery.git_refresh_single_flight) ||
    !b(recovery.child_reaping_canary_passed) ||
    !b(recovery.zombie_count_returned_to_baseline) ||
    !b(recovery.fd_count_returned_to_baseline) ||
    !b(recovery.thread_state_rehydrated_without_replay)
  ) {
    return out(false, "remote_lifecycle_canary_required", "verify_single_flight_refresh_child_reaping_resource_baselines_and_state_rehydration", operationId)
  }
  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  return out(true, "remote_process_lifecycle_contained", "continue_the_existing_operation_without_replaying_completed_writes", operationId, {
    continuity_route: routeType,
    observed_zombies: zombieCount,
    observed_children: childCount,
    observed_fds: fdCount,
  })
}

function evaluateBrowserHeartbeat(evidence, base) {
  const { operationId, state, route, routeType } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const action = evidence.requested_action ?? {}

  const affected =
    lower(observed.platform) === "windows" &&
    lower(observed.surface) === "in_app_browser_heartbeat" &&
    (b(observed.finalize_timeout) || b(observed.browser_kernel_reset) || b(observed.desktop_became_unresponsive))

  if (!affected) return out(true, "browser_heartbeat_not_affected", "continue_normal_automation", operationId)

  if (b(action.retry_same_wake) || b(action.restart_entire_desktop) || b(action.recreate_automation) || b(action.disable_all_automations)) {
    return out(false, "unsafe_browser_heartbeat_recovery", "open_the_browser_circuit_breaker_for_only_the_affected_automation_path", operationId)
  }
  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_task_and_reconcile_repository_connector_and_deployment_writes", operationId)
  }
  if (
    !b(recovery.browser_circuit_breaker_open) ||
    !b(recovery.same_wake_retry_suppressed) ||
    !b(recovery.non_browser_gate_continues) ||
    !b(recovery.browser_binding_marked_uncertain) ||
    !b(recovery.cleanup_timeout_receipt_recorded)
  ) {
    return out(false, "browser_circuit_breaker_required", "suppress_only_browser_work_preserve_the_schedule_and_continue_non_browser_checks", operationId)
  }
  if (!b(recovery.direct_api_or_connector_fallback_used) && !b(recovery.browser_work_deferred_until_canary)) {
    return out(false, "browser_continuity_path_missing", "use_a_verified_direct_api_or_connector_route_or_defer_only_browser_work_until_a_canary", operationId)
  }
  if (
    b(recovery.browser_authority_restored) &&
    (!b(recovery.claim_finalize_canary_passed) || !b(recovery.no_kernel_reset_canary_passed) || !b(recovery.desktop_responsive_canary_passed))
  ) {
    return out(false, "premature_browser_authority_restore", "keep_the_browser_circuit_breaker_open_until_all_cleanup_and_responsiveness_canaries_pass", operationId)
  }
  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  return out(true, "browser_heartbeat_failure_contained", "continue_the_automation_with_browser_work_rerouted_or_deferred", operationId, {
    continuity_route: routeType,
    browser_authority_restored: b(recovery.browser_authority_restored),
  })
}

function evaluateWindowBinding(evidence, base) {
  const { operationId, state, route, routeType } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const action = evidence.requested_action ?? {}

  const affected =
    lower(observed.surface) === "computer_use_window_binding" &&
    (b(observed.owner_mismatch) || b(observed.same_owner_rejected) || b(observed.wrong_window_content_captured))

  if (!affected) return out(true, "computer_use_window_binding_not_affected", "continue_normal_computer_use", operationId)

  if (b(action.accept_fallback_window) || b(action.capture_active_desktop) || b(action.reuse_stale_window_id) || b(action.continue_mutations_without_rebind)) {
    return out(false, "unsafe_window_binding_recovery", "withhold_only_the_affected_window_and_require_a_fresh_identity_bound_capture", operationId)
  }
  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_task_and_reconcile_repository_connector_and_deployment_writes", operationId)
  }
  if (
    !b(recovery.fresh_window_inventory_taken) ||
    !b(recovery.window_identity_bound_to_pid_and_process_start) ||
    !b(recovery.app_id_and_hwnd_match) ||
    !b(recovery.title_fingerprint_match) ||
    !b(recovery.visible_nonce_canary_match) ||
    !b(recovery.screenshot_scope_verified)
  ) {
    return out(false, "window_identity_unverified", "re_enumerate_and_bind_app_hwnd_pid_start_time_title_and_visible_nonce_before_capture", operationId)
  }
  if (b(recovery.computer_use_authority_restored) && !b(recovery.two_consecutive_target_capture_canaries_passed)) {
    return out(false, "premature_computer_use_restore", "require_two_consecutive_exact_target_capture_canaries", operationId)
  }
  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  return out(true, "computer_use_window_binding_contained", "continue_only_on_the_freshly_verified_target_window", operationId, {
    continuity_route: routeType,
    target_app_id: t(recovery.target_app_id),
    target_window_id: t(recovery.target_window_id),
  })
}

function evaluateWindowsApplyPatch(evidence, base) {
  const { operationId, state, route, routeType } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const action = evidence.requested_action ?? {}

  const affected =
    lower(observed.platform) === "windows" &&
    lower(observed.surface) === "apply_patch" &&
    lower(observed.sandbox_mode) === "unelevated" &&
    (b(observed.approval_request_aborted) || n(observed.os_error_code) === 5 || lower(observed.stderr).includes("access is denied"))

  if (!affected) return out(true, "windows_apply_patch_not_affected", "continue_normal_patch_application", operationId)

  if (b(action.retry_without_sandbox) || b(action.elevate_host) || b(action.broaden_workspace_acl) || b(action.replay_entire_task)) {
    return out(false, "unsafe_apply_patch_recovery", "preserve_the_sandbox_and_use_an_atomic_operation_bound_file_write_shim", operationId)
  }
  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_task_and_reconcile_repository_connector_and_deployment_writes", operationId)
  }
  if (
    !b(recovery.target_path_inside_verified_worktree) ||
    !b(recovery.expected_content_hash_recorded) ||
    !b(recovery.same_directory_temp_file_used) ||
    !b(recovery.atomic_rename_used) ||
    !b(recovery.final_content_hash_verified) ||
    !b(recovery.git_diff_receipt_recorded) ||
    !b(recovery.no_unsandboxed_execution)
  ) {
    return out(false, "atomic_patch_shim_incomplete", "write_to_a_same_directory_temp_file_fsync_rename_verify_hash_and_record_git_diff", operationId)
  }
  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  return out(true, "windows_apply_patch_failure_contained", "continue_the_existing_operation_with_the_verified_atomic_file_write", operationId, {
    continuity_route: routeType,
    target_path: t(recovery.target_path),
    content_hash: t(recovery.final_content_hash),
  })
}

export function evaluate(evidence) {
  const base = common(evidence ?? {})
  if (Object.hasOwn(base, "admitted")) return base
  if (evidence.mode === "remote_process_lifecycle") return evaluateRemoteLifecycle(evidence, base)
  if (evidence.mode === "browser_heartbeat_finalize") return evaluateBrowserHeartbeat(evidence, base)
  if (evidence.mode === "computer_use_window_binding") return evaluateWindowBinding(evidence, base)
  if (evidence.mode === "windows_apply_patch") return evaluateWindowsApplyPatch(evidence, base)
  return out(false, "unsupported_mode", "use_a_supported_execution_integrity_mode", base.operationId)
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
