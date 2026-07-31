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
])

const t = (value) => String(value ?? "").trim()
const b = (value) => value === true
const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)
const lower = (value) => t(value).toLowerCase()
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
    return out(false, "broad_containment_rejected", "quarantine_only_the_affected_windows_exec_step", operationId)
  }
  if (b(state.parent_task_replay_requested) || b(state.completed_write_replay_requested)) {
    return out(false, "unsafe_replay_rejected", "preserve_the_canonical_operation_and_reconcile_writes", operationId)
  }
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

function affected(observed) {
  const code = n(observed.error_code)
  return (
    lower(observed.platform) === "windows" &&
    lower(observed.surface) === "codex_exec" &&
    lower(observed.approval_mode) === "never" &&
    new Set([1344, 1920]).has(code)
  )
}

function evaluateSpawn(evidence, base) {
  const { operationId, route, routeType, state } = base
  const observed = evidence.observed ?? {}
  const recovery = evidence.recovery ?? {}
  const action = evidence.requested_action ?? {}
  const code = n(observed.error_code)

  if (!affected(observed)) {
    return out(true, "windows_headless_sandbox_not_affected", "continue_normal_sandbox_controls", operationId)
  }

  if (
    b(action.disable_sandbox) ||
    b(action.run_unsandboxed) ||
    b(action.enable_approval_escalation) ||
    b(action.grant_broad_acl) ||
    b(action.remove_entire_path) ||
    b(action.retry_from_home_directory)
  ) {
    return out(false, "unsafe_windows_sandbox_recovery", "preserve_sandboxing_and_apply_only_scoped_workdir_and_shell_path_repairs", operationId)
  }

  if (!writesReady(state)) {
    return out(false, "state_reconciliation_required", "checkpoint_task_and_reconcile_repository_connector_and_deployment_writes", operationId)
  }

  const homeFailure = code === 1344 || b(observed.home_directory_write_root_expansion)
  const shellFailure = code === 1920 || lower(observed.shell_path).includes("\\microsoft\\windowsapps\\")

  if (homeFailure) {
    const workdirReady =
      b(recovery.scoped_project_workdir) &&
      b(recovery.workdir_is_not_user_home) &&
      b(recovery.workdir_identity_verified) &&
      b(recovery.write_root_count_bounded) &&
      n(recovery.write_root_count) !== null &&
      n(recovery.write_root_count) <= n(recovery.write_root_limit)

    if (!workdirReady) {
      return out(false, "home_workdir_dacl_risk_unresolved", "launch_from_a_verified_scoped_project_directory_with_a_bounded_write_root_set", operationId)
    }
  }

  if (shellFailure) {
    const pathReady =
      b(recovery.only_per_user_windowsapps_removed) &&
      b(recovery.machine_wide_shell_resolved) &&
      b(recovery.shell_readable_by_sandbox_identity) &&
      b(recovery.shell_executable_by_sandbox_identity) &&
      !lower(recovery.resolved_shell_path).includes("\\microsoft\\windowsapps\\")

    if (!pathReady) {
      return out(false, "sandbox_shell_path_unresolved", "remove_only_the_per_user_windowsapps_alias_and_verify_a_machine_wide_shell", operationId)
    }
  }

  if (!b(recovery.sandbox_spawn_canary_passed) || !b(recovery.harmless_command_canary_passed)) {
    return out(false, "sandbox_canary_required", "verify_child_spawn_and_a_harmless_command_before_restoring_mutations", operationId)
  }

  if (!routeReady(route, routeType)) {
    return out(false, "continuity_route_unverified", "verify_a_pinned_approved_openai_or_authorized_local_route", operationId)
  }

  if (!new Set(["direct_openai_cli", "approved_windows_native_openai", "approved_local_openai"]).has(routeType)) {
    return out(false, "windows_exec_route_invalid", "continue_through_verified_direct_cli_or_authorized_windows_local_execution", operationId)
  }

  return out(true, "windows_headless_sandbox_failure_contained", "continue_the_existing_operation_without_replaying_completed_writes", operationId, {
    error_code: code,
    continuity_route: routeType,
    workdir: t(recovery.project_workdir),
    shell: t(recovery.resolved_shell_path),
  })
}

export function evaluate(evidence) {
  const base = common(evidence ?? {})
  if (Object.hasOwn(base, "admitted")) return base
  if (evidence.mode === "windows_headless_sandbox_spawn") return evaluateSpawn(evidence, base)
  return out(false, "unsupported_mode", "use_windows_headless_sandbox_spawn", base.operationId)
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
