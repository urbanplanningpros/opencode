import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const guard = fileURLToPath(new URL("./codex-plugin-catalog-pagination-guard.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-pagination-"))

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

const catalog = {
  endpoint: "ps/plugins/list",
  pages_fetched: 2,
  entries_fetched: 500,
  bytes_received: 2_000_000,
  max_pages: 32,
  max_entries: 5_000,
  max_bytes: 67_108_864,
  current_cursor: "cursor-1",
  next_cursor: "cursor-2",
  seen_cursor_tokens: ["cursor-0", "cursor-1"],
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  assert.equal(result.status, expectedCode, `${name}: ${result.stderr || result.stdout}`)
  const parsed = JSON.parse((result.stdout || result.stderr).trim())
  assert.equal(parsed.reason, expectedReason, name)
}

const base = {
  operation_id: "op-plugin-catalog",
  state,
  continuity_route: route,
  catalog,
}

run("healthy", base, 0, "plugin_catalog_pagination_healthy")
run("duplicate-token", { ...base, catalog: { ...catalog, duplicate_cursor_detected: true } }, 77, "plugin_catalog_pagination_containment_required")
run("same-token", { ...base, catalog: { ...catalog, next_cursor: "cursor-1" } }, 77, "plugin_catalog_pagination_containment_required")
run("cursor-cycle", { ...base, catalog: { ...catalog, next_cursor: "cursor-0" } }, 77, "plugin_catalog_pagination_containment_required")
run("page-budget", { ...base, catalog: { ...catalog, pages_fetched: 33 } }, 77, "plugin_catalog_pagination_containment_required")
run("entry-budget", { ...base, catalog: { ...catalog, entries_fetched: 5_001 } }, 77, "plugin_catalog_pagination_containment_required")
run("byte-budget", { ...base, catalog: { ...catalog, bytes_received: 67_108_865 } }, 77, "plugin_catalog_pagination_containment_required")
run("cache-replay", { ...base, catalog: { ...catalog, response_cache_replay_detected: true } }, 77, "plugin_catalog_pagination_containment_required")
run("mutation-quarantined", { ...base, catalog: { ...catalog, duplicate_cursor_detected: true, plugin_mutation_requested: true } }, 77, "plugin_catalog_mutation_quarantined")
run("state-missing", { ...base, state: { ...state, connector_writes_reconciled: false }, catalog: { ...catalog, duplicate_cursor_detected: true } }, 75, "state_reconciliation_required")
run("route-missing", { ...base, continuity_route: {}, catalog: { ...catalog, duplicate_cursor_detected: true } }, 75, "plugin_catalog_route_unverified")
run("contained-cache", { ...base, catalog: { ...catalog, duplicate_cursor_detected: true, request_cancelled: true, partial_catalog_discarded: true, cache_write_suppressed: true, blind_retry_suppressed: true, previous_verified_cache_available: true } }, 0, "plugin_catalog_anomaly_contained")
run("contained-manifest", { ...base, catalog: { ...catalog, response_cache_replay_detected: true, request_cancelled: true, partial_catalog_discarded: true, cache_write_suppressed: true, blind_retry_suppressed: true, pinned_static_manifest_available: true } }, 0, "plugin_catalog_anomaly_contained")
run("unapproved-route", { ...base, continuity_route: { ...route, type: "automatic_gateway" } }, 64, "unapproved_continuity_route")
run("broad-pause", { ...base, state: { ...state, broad_operator_pause_requested: true } }, 64, "broad_recovery_rejected")
run("unsafe-replay", { ...base, state: { ...state, parent_task_replay_requested: true } }, 64, "unsafe_replay_rejected")
run("fixed-canary-incomplete", { ...base, catalog: { ...catalog, fixed_build_canary_requested: true } }, 77, "plugin_catalog_fixed_build_canary_incomplete")
run("fixed-canary-passed", { ...base, catalog: { ...catalog, fixed_build_canary_requested: true, duplicate_cursor_guard_enabled: true, page_budget_enabled: true, entry_budget_enabled: true, byte_budget_enabled: true, repeated_cursor_canary_passed: true, rotating_cursor_canary_passed: true, partial_catalog_not_cached: true, rss_bounded_canary_passed: true, read_only_canary_passed: true } }, 0, "plugin_catalog_pagination_canaries_passed")

fs.rmSync(root, { recursive: true, force: true })
console.log("18 deterministic fixtures passed")
