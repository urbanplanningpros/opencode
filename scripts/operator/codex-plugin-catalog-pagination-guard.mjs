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

function integer(value, name, operationId, { min = 0 } = {}) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min) {
    finish(false, "malformed_evidence", `${name}_must_be_an_integer_at_least_${min}`, operationId, 2)
  }
  return number
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
const state = evidence.state || {}
const route = evidence.continuity_route || {}
const catalog = evidence.catalog || {}

if (!operationId) finish(false, "malformed_evidence", "operation_id_is_required", "", 2)
if (String(catalog.endpoint || "") !== "ps/plugins/list") {
  finish(false, "malformed_evidence", "catalog_endpoint_must_be_ps_plugins_list", operationId, 2)
}

const routeType = String(route.type || "")
if (routeType && !approvedRoutes.has(routeType)) {
  finish(false, "unapproved_continuity_route", "use_only_direct_openai_or_explicitly_authorized_local_routes", operationId, 64)
}
if (state.broad_operator_pause_requested === true || state.broad_host_shutdown_requested === true) {
  finish(false, "broad_recovery_rejected", "isolate_only_the_affected_plugin_catalog_walk", operationId, 64)
}
if (state.parent_task_replay_requested === true || state.completed_write_replay_requested === true) {
  finish(false, "unsafe_replay_rejected", "preserve_the_canonical_task_and_reconcile_writes_before_any_retry", operationId, 64)
}

const pages = integer(catalog.pages_fetched, "pages_fetched", operationId)
const entries = integer(catalog.entries_fetched, "entries_fetched", operationId)
const bytes = integer(catalog.bytes_received, "bytes_received", operationId)
const maxPages = integer(catalog.max_pages, "max_pages", operationId, { min: 1 })
const maxEntries = integer(catalog.max_entries, "max_entries", operationId, { min: 1 })
const maxBytes = integer(catalog.max_bytes, "max_bytes", operationId, { min: 1 })
const seenTokens = Array.isArray(catalog.seen_cursor_tokens)
  ? catalog.seen_cursor_tokens.map((value) => String(value))
  : []
const currentCursor = String(catalog.current_cursor || "")
const nextCursor = String(catalog.next_cursor || "")

const duplicateCursor =
  catalog.duplicate_cursor_detected === true ||
  (currentCursor.length > 0 && nextCursor.length > 0 && currentCursor === nextCursor)
const cursorCycle =
  catalog.cursor_cycle_detected === true ||
  (nextCursor.length > 0 && seenTokens.includes(nextCursor))
const pageBudgetExceeded = pages > maxPages
const entryBudgetExceeded = entries > maxEntries
const byteBudgetExceeded = bytes > maxBytes
const cacheReplay = catalog.response_cache_replay_detected === true
const anomaly =
  duplicateCursor ||
  cursorCycle ||
  pageBudgetExceeded ||
  entryBudgetExceeded ||
  byteBudgetExceeded ||
  cacheReplay

const routeReady =
  approvedRoutes.has(routeType) &&
  route.verified === true &&
  route.canary_passed === true &&
  route.operation_binding_matches === true &&
  route.workspace_state_verified === true &&
  route.pinned_openai_model === true &&
  route.automatic_model_selection_disabled === true &&
  route.excluded_provider_dependency_absent === true

const writesReconciled =
  state.task_state_checkpointed === true &&
  state.repository_writes_reconciled === true &&
  state.connector_writes_reconciled === true &&
  state.deployment_writes_reconciled === true

const containmentComplete =
  catalog.request_cancelled === true &&
  catalog.partial_catalog_discarded === true &&
  catalog.cache_write_suppressed === true &&
  catalog.blind_retry_suppressed === true &&
  (catalog.previous_verified_cache_available === true || catalog.pinned_static_manifest_available === true)

if (anomaly && catalog.plugin_mutation_requested === true && !containmentComplete) {
  finish(false, "plugin_catalog_mutation_quarantined", "withhold_only_plugin_install_update_share_or_publish_calls_until_catalog_containment_is_verified", operationId, 77, {
    duplicate_cursor: duplicateCursor,
    cursor_cycle: cursorCycle,
    page_budget_exceeded: pageBudgetExceeded,
    entry_budget_exceeded: entryBudgetExceeded,
    byte_budget_exceeded: byteBudgetExceeded,
    cache_replay: cacheReplay,
  })
}

if (anomaly && !writesReconciled) {
  finish(false, "state_reconciliation_required", "checkpoint_task_state_and_reconcile_repository_connector_and_deployment_writes", operationId, 75)
}
if (anomaly && !routeReady) {
  finish(false, "plugin_catalog_route_unverified", "continue_independent_work_only_through_a_verified_operation_scoped_direct_or_authorized_local_route", operationId, 75)
}
if (anomaly && !containmentComplete) {
  finish(false, "plugin_catalog_pagination_containment_required", "cancel_only_the_catalog_request_discard_partial_results_suppress_cache_write_and_use_a_verified_previous_cache_or_pinned_manifest", operationId, 77, {
    continuity_route: routeType,
    duplicate_cursor: duplicateCursor,
    cursor_cycle: cursorCycle,
    page_budget_exceeded: pageBudgetExceeded,
    entry_budget_exceeded: entryBudgetExceeded,
    byte_budget_exceeded: byteBudgetExceeded,
    cache_replay: cacheReplay,
  })
}
if (anomaly && containmentComplete) {
  finish(true, "plugin_catalog_anomaly_contained", "continue_non_plugin_work_and_use_only_the_verified_previous_catalog_or_pinned_static_manifest", operationId, 0, {
    continuity_route: routeType,
    catalog_source: catalog.previous_verified_cache_available === true ? "previous_verified_cache" : "pinned_static_manifest",
  })
}

if (catalog.fixed_build_canary_requested === true) {
  const canariesPassed =
    catalog.duplicate_cursor_guard_enabled === true &&
    catalog.page_budget_enabled === true &&
    catalog.entry_budget_enabled === true &&
    catalog.byte_budget_enabled === true &&
    catalog.repeated_cursor_canary_passed === true &&
    catalog.rotating_cursor_canary_passed === true &&
    catalog.partial_catalog_not_cached === true &&
    catalog.rss_bounded_canary_passed === true &&
    catalog.read_only_canary_passed === true

  if (!canariesPassed) {
    finish(false, "plugin_catalog_fixed_build_canary_incomplete", "keep_dynamic_catalog_refresh_quarantined_until_all_pagination_and_memory_canaries_pass", operationId, 77)
  }
  finish(true, "plugin_catalog_pagination_canaries_passed", "restore_bounded_dynamic_plugin_catalog_refresh_for_the_verified_build", operationId, 0)
}

finish(true, "plugin_catalog_pagination_healthy", "continue_with_bounded_plugin_catalog_refresh", operationId, 0, {
  pages_fetched: pages,
  entries_fetched: entries,
  bytes_received: bytes,
})
