import fs from "node:fs"
import path from "node:path"

const approvedRoutes = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_linux_openai",
])

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      i += 1
      continue
    }
    out[key] = true
  }
  return out
}

function readEvidence(file) {
  const full = path.resolve(file)
  const stat = fs.lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(full, "utf8"))
}

function finish(admitted, reason, action, operationId, code, extra = {}) {
  const payload = { admitted, reason, action, operation_id: operationId, ...extra }
  const stream = admitted ? process.stdout : process.stderr
  stream.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(code)
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) finish(false, "missing_input", "provide_evidence_json", "", 2)

let evidence
try {
  evidence = readEvidence(String(args.input))
} catch (error) {
  finish(false, "invalid_evidence", error.message, "", 2)
}

const operationId = String(evidence.operation_id || "").trim()
const mode = String(evidence.mode || "").trim()
const state = evidence.state || {}
const route = evidence.continuity_route || {}
const mcp = evidence.mcp || {}
const catalog = evidence.catalog || {}

if (!operationId) finish(false, "malformed_evidence", "operation_id_is_required", "", 2)
if (!new Set(["startup", "catalog"]).has(mode)) {
  finish(false, "malformed_evidence", "mode_must_be_startup_or_catalog", operationId, 2)
}

const routeType = String(route.type || "")
const routeReady =
  approvedRoutes.has(routeType) &&
  route.verified === true &&
  route.canary_passed === true &&
  route.operation_binding_matches === true &&
  route.workspace_state_verified === true &&
  route.pinned_openai_model === true &&
  route.automatic_model_selection_disabled === true &&
  route.excluded_provider_dependency_absent === true

if (routeType && !approvedRoutes.has(routeType)) {
  finish(false, "unapproved_continuity_route", "use_only_direct_openai_or_explicitly_authorized_local_routes", operationId, 64)
}
if (state.broad_host_shutdown_requested === true || state.broad_operator_pause_requested === true) {
  finish(false, "broad_recovery_rejected", "isolate_only_the_affected_mcp_server_or_tool_catalog", operationId, 64)
}
if (state.parent_task_replay_requested === true || state.completed_write_replay_requested === true) {
  finish(false, "unsafe_replay_rejected", "preserve_the_canonical_task_and_reconcile_writes_before_any_retry", operationId, 64)
}

const writesReconciled =
  state.task_state_checkpointed === true &&
  state.repository_writes_reconciled === true &&
  state.connector_writes_reconciled === true &&
  state.deployment_writes_reconciled === true

if (mode === "startup") {
  const server = String(mcp.server_name || "").trim()
  if (!server) finish(false, "malformed_evidence", "mcp_server_name_is_required", operationId, 2)

  const failed = mcp.initialize_succeeded === false
  const requiredFailure = mcp.required === true && mcp.enabled === true && failed
  const recoveryScope = String(mcp.recovery_scope || "")
  const safeRecoveryScope = new Set(["read_only_diagnostics", "repair_only"]).has(recoveryScope)
  const diagnosticsReady =
    mcp.diagnostics_redacted === true &&
    mcp.stderr_bounded === true &&
    String(mcp.protocol_version || "").trim().length > 0 &&
    String(mcp.jsonrpc_error_code || "").trim().length > 0

  if (requiredFailure && Number(mcp.retry_count || 0) > 1 && mcp.server_artifact_changed !== true) {
    finish(false, "blind_mcp_retry_rejected", "stop_repeating_the_same_initialize_handshake_until_the_server_or_configuration_changes", operationId, 64, { server })
  }

  if (requiredFailure && mcp.dependent_work_requested === true) {
    finish(false, "required_mcp_dependency_unavailable", "defer_only_work_that_requires_this_server_and_continue_independent_work", operationId, 77, { server })
  }

  if (requiredFailure && mcp.recovery_mode_requested === true) {
    if (!writesReconciled) {
      finish(false, "state_reconciliation_required", "checkpoint_the_task_and_reconcile_repository_connector_and_deployment_writes", operationId, 75, { server })
    }
    if (!diagnosticsReady) {
      finish(false, "mcp_diagnostics_required", "capture_redacted_bounded_initialize_diagnostics_before_recovery", operationId, 75, { server })
    }
    if (!safeRecoveryScope || mcp.recovery_banner_present !== true) {
      finish(false, "unsafe_mcp_recovery_scope", "use_an_explicit_read_only_or_repair_only_session_with_a_persistent_degraded_banner", operationId, 64, { server })
    }
    if (mcp.sandbox_preserved !== true || mcp.approvals_preserved !== true) {
      finish(false, "mcp_recovery_security_boundary_missing", "preserve_normal_sandbox_and_approval_controls", operationId, 64, { server })
    }
    if (!routeReady) {
      finish(false, "mcp_recovery_route_unverified", "bind_recovery_to_a_verified_operation_scoped_direct_or_authorized_local_route", operationId, 75, { server })
    }
    finish(true, "mcp_recovery_mode_admitted", "repair_or_diagnose_only_the_failed_mcp_then_retest_initialization_without_replaying_the_parent_task", operationId, 0, {
      server,
      continuity_route: routeType,
      recovery_scope: recoveryScope,
    })
  }

  const startupRestored =
    mcp.server_fix_verified === true &&
    mcp.initialize_succeeded === true &&
    mcp.startup_canary_passed === true &&
    mcp.tool_catalog_canary_passed === true

  if (startupRestored) {
    finish(true, "mcp_startup_canaries_passed", "restore_normal_mcp_dependent_work_for_the_verified_server", operationId, 0, { server })
  }
  if (requiredFailure) {
    finish(false, "required_mcp_startup_quarantined", "open_an_explicit_safe_recovery_session_or_use_the_verified_continuity_route_for_independent_work", operationId, 77, { server })
  }
  finish(true, "mcp_startup_healthy", "continue_with_normal_mcp_startup_policy", operationId, 0, { server })
}

const server = String(catalog.server_name || "").trim()
if (!server) finish(false, "malformed_evidence", "catalog_server_name_is_required", operationId, 2)
if (catalog.raw_tools_list_captured !== true || catalog.secret_free_diagnostics !== true) {
  finish(false, "raw_mcp_catalog_receipt_required", "capture_a_redacted_raw_tools_list_and_server_identity_before_using_projected_metadata", operationId, 75, { server })
}

const rawIdentity = String(catalog.raw_server_identity || "").trim()
const activeIdentity = String(catalog.active_server_identity || "").trim()
const cachedIdentity = String(catalog.cached_server_identity || "").trim()
const rawFingerprint = String(catalog.raw_schema_fingerprint || "").trim()
const projectedFingerprint = String(catalog.projected_schema_fingerprint || "").trim()
const projectedType = String(catalog.projected_schema_type || "").trim().toLowerCase()

if (!rawIdentity || !activeIdentity || !rawFingerprint) {
  finish(false, "incomplete_mcp_catalog_identity", "record_raw_and_active_server_identity_plus_a_deterministic_schema_fingerprint", operationId, 75, { server })
}

const identityMismatch = rawIdentity !== activeIdentity || (cachedIdentity && cachedIdentity !== activeIdentity)
const schemaLost = catalog.raw_schema_structured === true && (projectedType === "unknown" || !projectedFingerprint)
const schemaMismatch = projectedFingerprint && projectedFingerprint !== rawFingerprint
const refreshRequired = identityMismatch || schemaLost || schemaMismatch || catalog.schema_changed === true
const refreshComplete =
  catalog.cached_metadata_invalidated === true &&
  catalog.refresh_completed === true &&
  catalog.deferred_tools_refreshed === true &&
  catalog.active_server_identity === catalog.raw_server_identity &&
  catalog.projected_schema_fingerprint === catalog.raw_schema_fingerprint &&
  catalog.catalog_canary_passed === true

if (refreshRequired && catalog.tool_call_requested === true && !refreshComplete) {
  finish(false, "stale_or_lossy_mcp_catalog_rejected", "withhold_only_calls_to_the_affected_tools_until_identity_and_schema_refresh_complete", operationId, 77, {
    server,
    identity_mismatch: identityMismatch,
    schema_lost: schemaLost,
    schema_mismatch: schemaMismatch,
  })
}
if (refreshRequired && !refreshComplete) {
  if (!writesReconciled) {
    finish(false, "state_reconciliation_required", "checkpoint_the_task_and_reconcile_durable_writes_before_catalog_refresh", operationId, 75, { server })
  }
  if (!routeReady) {
    finish(false, "mcp_catalog_route_unverified", "continue_independent_work_only_through_a_verified_operation_scoped_route", operationId, 75, { server })
  }
  finish(false, "mcp_catalog_refresh_required", "invalidate_cached_metadata_rerun_initialize_and_tools_list_then_bind_the_new_identity_and_schema_fingerprint", operationId, 77, {
    server,
    continuity_route: routeType,
  })
}
if (refreshRequired && refreshComplete) {
  finish(true, "mcp_catalog_refresh_canaries_passed", "restore_calls_to_the_refreshed_tools_using_the_verified_schema", operationId, 0, { server })
}
finish(true, "mcp_catalog_identity_and_schema_match", "continue_with_normal_mcp_tool_calls", operationId, 0, { server })
