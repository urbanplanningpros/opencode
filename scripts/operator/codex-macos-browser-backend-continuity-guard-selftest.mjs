#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-macos-browser-backend-continuity-guard.mjs", import.meta.url)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-macos-browser-guard-"))

const base = {
  task_id: "task-1",
  operation_id: "op-1",
  idempotency_key: "idem-1",
  platform: "macOS arm64",
  desktop_version: "26.721.81911",
  browser_plugin_version: "26.721.81911",
  browser_skill_present: true,
  node_runtime_available: true,
  browser_bootstrap_completed: true,
  browser_backends: [],
  browser_error: "No browser is available",
  browser_control_required: true,
  task_state_preserved: true,
  external_writes_reconciled: true,
  bootstrap_attempt_count: 1,
  automatic_task_replay_requested: false,
  routing: {
    provider: "openai",
    route: "direct",
    automatic_selector: false,
    model_gateway: false,
  },
}

function run(name, patch) {
  const evidence = { ...base, ...patch }
  if (patch.routing) evidence.routing = { ...base.routing, ...patch.routing }
  const input = path.join(temp, `${name}.json`)
  fs.writeFileSync(input, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard.pathname, "--input", input, "--json"], { encoding: "utf8" })
  return { code: result.status, body: JSON.parse(result.stdout || "{}"), stderr: result.stderr }
}

let result = run("healthy-backend", {
  desktop_version: "26.721.41059",
  browser_backends: ["Codex In-app Browser"],
  browser_error: "",
  fallback_target: "none",
})
assert.equal(result.code, 0)
assert.equal(result.body.browser_backend_incident, false)

result = run("incident-no-fallback", { fallback_target: "none" })
assert.equal(result.code, 64)
assert(result.body.blocked.includes("browser_control_requires_approved_fallback"))

result = run("missing-state-preservation", {
  task_state_preserved: false,
  fallback_target: "authorized_local_browser_executor",
  explicit_local_route_authorized: true,
  local_executor_receipt_sha256: "a".repeat(64),
  browser_discovery_canary_passed: true,
})
assert.equal(result.code, 64)
assert(result.body.blocked.includes("task_state_must_be_preserved"))

result = run("official-pin-missing-receipts", {
  fallback_target: "official_pinned_desktop_26_721_41059",
})
assert.equal(result.code, 64)
assert(result.body.blocked.includes("official_package_sha256_required"))

result = run("official-pin-verified", {
  fallback_target: "official_pinned_desktop_26_721_41059",
  official_openai_package_source_verified: true,
  official_package_sha256: "b".repeat(64),
  current_installation_rollback_preserved: true,
  auto_update_pinned_until_fix: true,
  browser_discovery_canary_passed: true,
  browser_backend_discovered_after_fallback: true,
})
assert.equal(result.code, 0)

result = run("approved-local", {
  fallback_target: "authorized_local_browser_executor",
  explicit_local_route_authorized: true,
  local_executor_receipt_sha256: "c".repeat(64),
  browser_discovery_canary_passed: true,
})
assert.equal(result.code, 0)

result = run("prohibited-route", {
  fallback_target: "authorized_local_browser_executor",
  explicit_local_route_authorized: true,
  local_executor_receipt_sha256: "d".repeat(64),
  browser_discovery_canary_passed: true,
  routing: { provider: "openai", route: "model-gateway-auto-select" },
})
assert.equal(result.code, 64)
assert(result.body.blocked.includes("prohibited_route_metadata"))

result = run("browser-not-required", {
  browser_control_required: false,
  fallback_target: "none",
})
assert.equal(result.code, 0)
assert(result.body.warnings.includes("isolate_only_in_app_browser_and_continue_unaffected_work"))

result = run("replay-rejected", {
  automatic_task_replay_requested: true,
  fallback_target: "authorized_local_browser_executor",
  explicit_local_route_authorized: true,
  local_executor_receipt_sha256: "e".repeat(64),
  browser_discovery_canary_passed: true,
})
assert.equal(result.code, 64)
assert(result.body.blocked.includes("automatic_task_replay_forbidden"))

fs.rmSync(temp, { recursive: true, force: true })
console.log("codex-macos-browser-backend-continuity-guard: 9 fixtures passed")
