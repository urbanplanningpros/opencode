import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-linux-chrome-bootstrap-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-chrome-bootstrap-"))

function run(name, evidence, expectedStatus, expectedState, expectedToken = null) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.status, expectedState)
  if (expectedToken) {
    assert.equal([...report.blocked, ...report.remediation, ...report.warnings].includes(expectedToken), true, `${name}: missing ${expectedToken}`)
  }
}

const base = {
  task_id: "task-36175",
  operation_id: "operation-36175",
  idempotency_key: "idem-36175",
  platform: "Linux 7.1 native x86_64",
  codex_cli_version: "0.146.0",
  chrome_plugin_version: "26.721.81911",
  node_repl_available: true,
  chrome_extension_connected: true,
  browser_client_import_error: 'Importing module "node:process" is not allowed in node_repl',
  blocked_module: "node:process",
  global_agent_defined: false,
  browser_control_required: true,
  task_state_preserved: true,
  external_writes_reconciled: true,
  bootstrap_retry_count: 1,
  broad_node_builtin_permission_requested: false,
  bundled_plugin_cache_edited_in_place: false,
  unverified_browser_client_shim_requested: false,
  browser_client_shim_verified: false,
  browser_control_canary_passed: false,
  fallback_target: "authorized_local_browser_executor",
  routing: {
    provider: "approved-local",
    route: "authorized_local_browser_executor",
    automatic_selector: false,
    model_gateway: false,
  },
}

run("approved-fallback", base, 0, "compatible")
run("missing-fallback", { ...base, fallback_target: "none", routing: { ...base.routing, route: "direct" } }, 64, "blocked", "browser_control_requires_verified_approved_fallback_or_shim")
run("unsafe-permission", { ...base, broad_node_builtin_permission_requested: true }, 64, "blocked", "broad_node_builtin_permission_forbidden")
run("cache-edit", { ...base, bundled_plugin_cache_edited_in_place: true }, 64, "blocked", "bundled_plugin_cache_edit_forbidden")
run("unreconciled", { ...base, external_writes_reconciled: false }, 64, "blocked", "external_writes_must_be_reconciled")
run("non-browser", { ...base, browser_control_required: false, fallback_target: "none", routing: { ...base.routing, route: "direct" } }, 75, "remediation_required", "disable_only_bundled_chrome_control_for_this_operation")
run("verified-shim-needs-canary", {
  ...base,
  fallback_target: "none",
  routing: { ...base.routing, route: "checksum-bound-local-shim" },
  browser_client_shim_verified: true,
  browser_client_shim_source_sha256: "a".repeat(64),
  browser_client_shim_output_sha256: "b".repeat(64),
  browser_control_canary_passed: false,
}, 75, "remediation_required", "run_disposable_browser_control_canary")
run("prohibited", { ...base, fallback_target: "none", routing: { provider: "openrouter", route: "auto-select" } }, 64, "blocked", "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Linux Chrome bootstrap continuity guard self-test passed")
