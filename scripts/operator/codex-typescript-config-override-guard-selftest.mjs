import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-typescript-config-override-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-typescript-config-override-"))

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

const receipt = "7".repeat(64)
const base = {
  task_id: "task-ts-config",
  operation_id: "operation-ts-config",
  idempotency_key: "idem-ts-config",
  sdk_language: "typescript",
  codex_sdk_version: "0.146.0",
  execution_route: "typescript_sdk_structured",
  process_permission_profile_id: "profile-readonly",
  config_receipt_sha256: receipt,
  concurrent_process_count: 1,
  config_map_keys: ["workspace"],
  raw_config_arguments: [],
  shared_codex_home_config_mutation_requested: false,
  shell_interpretation_disabled: true,
  separate_argv_binding_verified: true,
  inline_toml_table_used: false,
  typescript_sdk_raw_override_support_available: false,
  per_process_config_isolated: true,
  post_launch_config_readback_passed: true,
  mutation_authority_requested: false,
  shared_config_restored_after_launch: true,
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
}

const dotted = {
  ...base,
  config_map_keys: ["/tmp/sdk-path.with-dot", ".worktrees"],
  mutation_authority_requested: true,
}

const rawRoute = {
  ...base,
  execution_route: "direct_codex_cli_argv",
  config_map_keys: ["/tmp/sdk-path.with-dot", ".worktrees"],
  raw_config_arguments: ['permissions.andromede.filesystem={":root"="read","/tmp/sdk-path.with-dot"="deny",".worktrees"="read"}'],
  inline_toml_table_used: true,
  shell_interpretation_disabled: true,
  separate_argv_binding_verified: true,
  per_process_config_isolated: true,
  post_launch_config_readback_passed: true,
  mutation_authority_requested: true,
}

run("safe-structured", base, 0, "compatible")
run("dotted-structured-blocked", dotted, 64, "blocked", "lossy_dotted_map_key_serialization")
run("dotted-needs-lossless-route", { ...dotted, mutation_authority_requested: false }, 75, "remediation_required", "use_direct_codex_cli_argv_or_official_python_sdk_config_overrides")
run("safe-direct-cli", rawRoute, 0, "compatible")
run("missing-raw-argument", { ...rawRoute, raw_config_arguments: [] }, 64, "blocked", "raw_config_argument_missing")
run("shell-interpolation", { ...rawRoute, shell_interpretation_disabled: false }, 64, "blocked", "shell_interpretation_must_be_disabled")
run("argv-not-bound", { ...rawRoute, separate_argv_binding_verified: false }, 64, "blocked", "separate_argv_binding_required")
run("shared-config-race", {
  ...rawRoute,
  shared_codex_home_config_mutation_requested: true,
  concurrent_process_count: 3,
}, 64, "blocked", "shared_codex_home_permission_race")
run("readback-required", { ...rawRoute, post_launch_config_readback_passed: false }, 75, "remediation_required", "verify_effective_permission_config_after_process_start")
run("prohibited-route", {
  ...rawRoute,
  routing: { provider: "openrouter", route: "auto-select", automatic_selector: true, model_gateway: true },
}, 64, "blocked", "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex TypeScript config override guard self-test passed")
