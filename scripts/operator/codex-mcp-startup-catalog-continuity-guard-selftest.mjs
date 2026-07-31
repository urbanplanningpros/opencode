import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const guard = fileURLToPath(new URL("./codex-mcp-startup-catalog-continuity-guard.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-continuity-"))

const route = {
  type: "direct_openai_cli",
  verified: true,
  canary_passed: true,
  operation_binding_matches: true,
  workspace_state_verified: true,
  pinned_openai_model: true,
  automatic_model_selection_disabled: true,
  excluded_provider_dependency_absent: true,
}

const state = {
  task_state_checkpointed: true,
  repository_writes_reconciled: true,
  connector_writes_reconciled: true,
  deployment_writes_reconciled: true,
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  assert.equal(result.status, expectedCode, `${name}: ${result.stderr || result.stdout}`)
  const parsed = JSON.parse((result.stdout || result.stderr).trim())
  assert.equal(parsed.reason, expectedReason, name)
}

const baseStartup = {
  operation_id: "op-startup",
  mode: "startup",
  state,
  continuity_route: route,
  mcp: {
    server_name: "project-mcp",
    enabled: true,
    required: true,
    initialize_succeeded: false,
    protocol_version: "2025-06-18",
    jsonrpc_error_code: "-32602",
    diagnostics_redacted: true,
    stderr_bounded: true,
    retry_count: 1,
  },
}

run("healthy-startup", { ...baseStartup, mcp: { ...baseStartup.mcp, initialize_succeeded: true, server_fix_verified: true, startup_canary_passed: true, tool_catalog_canary_passed: true } }, 0, "mcp_startup_canaries_passed")
run("dependent-work-deferred", { ...baseStartup, mcp: { ...baseStartup.mcp, dependent_work_requested: true } }, 77, "required_mcp_dependency_unavailable")
run("blind-retry", { ...baseStartup, mcp: { ...baseStartup.mcp, retry_count: 3 } }, 64, "blind_mcp_retry_rejected")
run("recovery-state-missing", { ...baseStartup, state: { ...state, connector_writes_reconciled: false }, mcp: { ...baseStartup.mcp, recovery_mode_requested: true, recovery_scope: "repair_only", recovery_banner_present: true, sandbox_preserved: true, approvals_preserved: true } }, 75, "state_reconciliation_required")
run("recovery-scope-unsafe", { ...baseStartup, mcp: { ...baseStartup.mcp, recovery_mode_requested: true, recovery_scope: "normal_mutating_work", recovery_banner_present: true, sandbox_preserved: true, approvals_preserved: true } }, 64, "unsafe_mcp_recovery_scope")
run("recovery-admitted", { ...baseStartup, mcp: { ...baseStartup.mcp, recovery_mode_requested: true, recovery_scope: "repair_only", recovery_banner_present: true, sandbox_preserved: true, approvals_preserved: true } }, 0, "mcp_recovery_mode_admitted")
run("startup-quarantined", baseStartup, 77, "required_mcp_startup_quarantined")
run("unapproved-route", { ...baseStartup, continuity_route: { ...route, type: "automatic_gateway" } }, 64, "unapproved_continuity_route")

const baseCatalog = {
  operation_id: "op-catalog",
  mode: "catalog",
  state,
  continuity_route: route,
  catalog: {
    server_name: "project-mcp",
    raw_tools_list_captured: true,
    secret_free_diagnostics: true,
    raw_server_identity: "project-mcp@2.0.0",
    active_server_identity: "project-mcp@2.0.0",
    cached_server_identity: "project-mcp@2.0.0",
    raw_schema_fingerprint: "sha256:new",
    projected_schema_fingerprint: "sha256:new",
    projected_schema_type: "object",
    raw_schema_structured: true,
    catalog_canary_passed: true,
  },
}

run("catalog-healthy", baseCatalog, 0, "mcp_catalog_identity_and_schema_match")
run("catalog-receipt-missing", { ...baseCatalog, catalog: { ...baseCatalog.catalog, raw_tools_list_captured: false } }, 75, "raw_mcp_catalog_receipt_required")
run("lossy-tool-call", { ...baseCatalog, catalog: { ...baseCatalog.catalog, projected_schema_type: "unknown", projected_schema_fingerprint: "", tool_call_requested: true } }, 77, "stale_or_lossy_mcp_catalog_rejected")
run("identity-refresh-required", { ...baseCatalog, catalog: { ...baseCatalog.catalog, active_server_identity: "project-mcp@2.0.0", cached_server_identity: "project-mcp@1.0.0", projected_schema_fingerprint: "sha256:old" } }, 77, "mcp_catalog_refresh_required")
run("refresh-route-missing", { ...baseCatalog, continuity_route: {}, catalog: { ...baseCatalog.catalog, cached_server_identity: "project-mcp@1.0.0" } }, 75, "mcp_catalog_route_unverified")
run("refresh-complete", { ...baseCatalog, catalog: { ...baseCatalog.catalog, cached_server_identity: "project-mcp@1.0.0", schema_changed: true, cached_metadata_invalidated: true, refresh_completed: true, deferred_tools_refreshed: true } }, 0, "mcp_catalog_refresh_canaries_passed")
run("broad-pause", { ...baseCatalog, state: { ...state, broad_operator_pause_requested: true } }, 64, "broad_recovery_rejected")
run("replay-rejected", { ...baseCatalog, state: { ...state, parent_task_replay_requested: true } }, 64, "unsafe_replay_rejected")

fs.rmSync(root, { recursive: true, force: true })
console.log("16 deterministic fixtures passed")
