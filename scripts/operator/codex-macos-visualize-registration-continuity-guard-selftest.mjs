import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"

const guard = new URL("./codex-macos-visualize-registration-continuity-guard.mjs", import.meta.url).pathname
const dir = mkdtempSync(path.join(os.tmpdir(), "codex-macos-vis-guard-"))
const digest = "a".repeat(64)

const base = {
  operation_id: "op-36234",
  task_id: "task-36234",
  platform: "macos-darwin-arm64",
  app_version: "26.727.40816",
  plugin_version: "visualize@openai-bundled-1.0.16",
  visualize_enabled: true,
  materialized_variant: "live-disabled",
  production_dispatch_enabled: false,
  native_registration_present: false,
  fresh_task_discovery_performed: true,
  try_now_used: true,
  try_now_used_native_path: false,
  repeated_bootstrap_suppressed: true,
  bundle_or_cache_mutation_requested: false,
  task_state_checkpointed: true,
  repository_writes_reconciled: true,
  external_writes_reconciled: true,
  fallback_route: "static_html_svg_png",
  fallback_canary_passed: true,
  artifact_path_bound: true,
  artifact_sha256: digest,
  corrected_build_canary_passed: false,
}

function run(name, patch = {}) {
  const file = path.join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify({ ...base, ...patch }))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  const output = JSON.parse(result.stdout || result.stderr)
  return { ...output, status: result.status }
}

try {
  assert.equal(run("fallback").reason, "native_visualize_unavailable_explicit_artifact_fallback_active")
  assert.equal(run("no-route", { fallback_route: "none" }).status, 75)
  assert.equal(run("no-discovery", { fresh_task_discovery_performed: false }).reason, "fresh_task_capability_discovery_required")
  assert.equal(run("unreconciled", { external_writes_reconciled: false }).reason, "operator_state_reconciliation_required_before_visualization_reroute")
  assert.equal(run("repeat-bootstrap", { repeated_bootstrap_suppressed: false }).reason, "repeated_visualize_bootstrap_must_be_suppressed")
  assert.equal(run("cache-mutation", { bundle_or_cache_mutation_requested: true }).status, 64)
  assert.equal(run("prohibited-route", { fallback_route: "vertex" }).status, 64)
  assert.equal(run("missing-hash", { artifact_sha256: "" }).reason, "fallback_artifact_binding_and_canary_required")
  assert.equal(run("healthy-native", {
    materialized_variant: "live-enabled",
    production_dispatch_enabled: true,
    native_registration_present: true,
    try_now_used_native_path: true,
    fallback_route: "none",
    fallback_canary_passed: false,
    artifact_path_bound: false,
    artifact_sha256: "",
  }).reason, "visualize_native_registration_verified")
  const corrected = run("corrected", {
    materialized_variant: "live-enabled",
    production_dispatch_enabled: true,
    native_registration_present: true,
    try_now_used_native_path: true,
    fallback_route: "none",
    fallback_canary_passed: false,
    artifact_path_bound: false,
    artifact_sha256: "",
    corrected_build_canary_passed: true,
  })
  assert.equal(corrected.status, 0)
  assert.equal(corrected.reason, "corrected_visualize_build_verified")
  console.log("10 deterministic fixtures passed")
} finally {
  rmSync(dir, { recursive: true, force: true })
}
