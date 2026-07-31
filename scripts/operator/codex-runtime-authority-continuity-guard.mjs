#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROUTES = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_windows_native_openai",
  "approved_linux_openai",
])
const t = (v) => String(v ?? "").trim()
const b = (v) => v === true
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
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
  if (b(state.broad_operator_pause_requested) || b(state.host_wide_shutdown_requested)) {
    return out(false, "broad_containment_rejected", "quarantine_only_the_affected_surface", operationId)
  }
  if (b(state.parent_task_replay_requested) || b(state.completed_write_replay_requested)) {
    return out(false, "unsafe_replay_rejected", "preserve_the_canonical_operation_and_reconcile_writes", operationId)
  }
  const route = evidence.continuity_route ?? {}
  const routeType = t(route.type)
  if (routeType && !ROUTES.has(routeType)) {
    return out(false, "unapproved_continuity_route", "use_only_pinned_direct_openai_or_authorized_local_routes", operationId)
  }
  if (b(route.model_gateway_present) || b(route.automatic_model_selection_enabled) || b(route.excluded_provider_dependency_present)) {
    return out(false, "route_authority_invalid", "remove_gateways_auto_selection_and_excluded_dependencies", operationId)
  }
  return { operationId, route, routeType, state }
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

function runtime(evidence, base) {
  const { operationId, route, routeType, state } = base
  const requested = evidence.requested_runtime ?? {}
  const observed = evidence.observed_runtime ?? {}
  const action = evidence.requested_action ?? {}
  const requestedModel = t(requested.model)
  const requestedProvider = t(requested.provider || "openai")
  const requestedTier = t(requested.service_tier)
  const observedModel = t(observed.model)
  const observedProvider = t(observed.provider)
  const observedTier = t(observed.service_tier)

  if (!requestedModel || requestedProvider !== "openai") {
    return out(false, "runtime_request_invalid", "request_an_explicit_approved_openai_runtime", operationId)
  }
  if (!b(observed.receipt_present) || !observedModel || !observedProvider) {
    return out(false, "runtime_receipt_missing", "read_back_effective_model_provider_reasoning_and_tier", operationId)
  }
  const drift = requestedModel !== observedModel || requestedProvider !== observedProvider || (requestedTier && requestedTier !== observedTier)
  if (!drift) {
    return out(true, "runtime_authority_verified", "continue_with_the_operation_bound_runtime_receipt", operationId, {
      model: observedModel,
      service_tier: observedTier || "unreported",
    })
  }
  if (b(action.trust_config_without_readback) || b(action.continue_mutating_on_drift)) {
    return out(false, "runtime_drift_not_contained", "do_not_treat_config_as_effective_runtime_authority", operationId)
  }
  if (!writesReady(state) || !routeReady(route, routeType)) {
    return out(false, "runtime_reroute_unverified", "checkpoint_state_and_verify_a_pinned_approved_route", operationId)
  }
  if (routeType === "direct_openai_cli") {
    if (!b(route.explicit_model_argument) || t(route.observed_model) !== requestedModel || !b(route.first_turn_receipt_present)) {
      return out(false, "cli_model_pin_unverified", "launch_with_an_explicit_model_argument_and_verify_first_turn_state", operationId)
    }
    if (requestedTier && t(route.observed_service_tier) !== requestedTier) {
      return out(false, "cli_service_tier_unverified", "use_direct_openai_api_for_tier_sensitive_work_or_apply_a_hard_budget", operationId)
    }
  }
  if (routeType === "direct_openai_api") {
    const modelOk = t(route.request_model) === requestedModel && t(route.response_model) === requestedModel
    const tierOk = !requestedTier || (t(route.request_service_tier) === requestedTier && t(route.response_service_tier) === requestedTier)
    if (!modelOk || !tierOk) {
      return out(false, "api_runtime_receipt_mismatch", "require_exact_request_and_response_runtime_receipts", operationId)
    }
  }
  return out(true, "runtime_drift_contained", "continue_without_replaying_completed_writes", operationId, {
    continuity_route: routeType,
  })
}

function wsl(evidence, base) {
  const { operationId, route, routeType, state } = base
  const observed = evidence.observed ?? {}
  const config = evidence.config ?? {}
  const action = evidence.requested_action ?? {}
  const affected = t(observed.platform) === "windows" && b(observed.wsl_selected) && b(observed.state_db_backfill_running) && t(observed.initialize_result) === "timeout"
  if (!affected) return out(true, "wsl_bootstrap_healthy_or_not_affected", "continue_normal_startup_controls", operationId)
  if (b(action.delete_state_db) || b(action.copy_live_sqlite_across_mount) || b(action.repeat_startup_loop)) {
    return out(false, "destructive_wsl_recovery_rejected", "preserve_state_and_avoid_live_database_copy_or_deletion", operationId)
  }
  const recovered =
    config.config_toml_wsl === false &&
    config.global_state_wsl === false &&
    b(config.sources_reconciled) &&
    b(config.native_executable_observed) &&
    t(config.native_initialize_result) === "success"
  if (!recovered || !writesReady(state) || !routeReady(route, routeType)) {
    return out(false, "wsl_bootstrap_recovery_unverified", "reconcile_both_config_sources_and_verify_windows_native_startup", operationId)
  }
  if (!new Set(["approved_windows_native_openai", "direct_openai_cli"]).has(routeType)) {
    return out(false, "wsl_fallback_route_invalid", "continue_on_verified_windows_native_openai_or_pinned_cli", operationId)
  }
  return out(true, "wsl_bootstrap_failure_contained", "continue_the_existing_operation_on_windows_native_openai", operationId, {
    continuity_route: routeType,
  })
}

function security(evidence, base) {
  const { operationId, route, routeType, state } = base
  const workspace = evidence.workspace ?? {}
  const consent = evidence.consent ?? {}
  const action = evidence.requested_action ?? {}
  const current = n(workspace.renderer_count)
  const prior = n(workspace.prior_renderer_count)
  const rendererLoop = b(workspace.security_panel_opened) && current !== null && prior !== null && current > prior && b(workspace.backend_scan_healthy)
  const falseDecline = t(consent.tool_status) === "declined" && !b(consent.user_interaction_receipt_present)
  if (!rendererLoop && !falseDecline) return out(true, "security_workspace_healthy", "continue_normal_scan_and_consent_controls", operationId)
  if (falseDecline && b(action.apply_remediation_as_declined_or_approved)) {
    return out(false, "synthetic_consent_rejected", "require_a_separate_explicit_user_decision_receipt", operationId)
  }
  if (rendererLoop && (b(action.kill_by_process_name) || b(action.restart_scan))) {
    return out(false, "unsafe_security_workspace_recovery", "quarantine_only_the_panel_and_preserve_the_backend_scan", operationId)
  }
  if (!writesReady(state)) {
    return out(false, "security_state_reconciliation_required", "checkpoint_scan_task_and_external_write_state", operationId)
  }
  if (rendererLoop) {
    const contained =
      b(workspace.panel_quarantined) &&
      b(workspace.scan_id_preserved) &&
      b(workspace.backend_status_readback_present) &&
      b(workspace.new_renderer_spawns_stopped) &&
      routeReady(route, routeType)
    if (!contained) return out(false, "renderer_loop_not_contained", "preserve_the_scan_and_verify_non_ui_continuity", operationId)
  }
  if (falseDecline) {
    const contained =
      b(consent.synthetic_result_marked_invalid) &&
      b(consent.remediation_mutation_withheld) &&
      b(consent.read_only_scan_allowed) &&
      b(consent.separate_approval_channel_prepared)
    if (!contained) return out(false, "false_decline_not_contained", "invalidate_the_result_and_withhold_only_the_remediation", operationId)
  }
  return out(true, "security_workspace_failure_contained", "continue_read_only_scan_and_require_explicit_consent_for_remediation", operationId, {
    continuity_route: routeType || "existing_backend_scan",
  })
}

export function evaluate(evidence) {
  const base = common(evidence ?? {})
  if (Object.hasOwn(base, "admitted")) return base
  if (evidence.mode === "runtime_authority") return runtime(evidence, base)
  if (evidence.mode === "wsl_bootstrap") return wsl(evidence, base)
  if (evidence.mode === "security_workspace") return security(evidence, base)
  return out(false, "unsupported_mode", "use_runtime_authority_wsl_bootstrap_or_security_workspace", base.operationId)
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
