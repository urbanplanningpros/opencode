import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-linux-unreachable-cwd-continuity-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-unreachable-cwd-"))

const base = {
  task_id: "task-cwd-1",
  operation_id: "op-cwd-1",
  idempotency_key: "idem-cwd-1",
  runtime: {
    platform: "linux-x86_64",
    codex_version: "0.146.0-alpha.3.1",
    cwd_raw: "/home/user/src",
    proc_self_cwd: "/home/user/src",
    nested_mount_namespace: false,
  },
  startup: {
    app_server_requested: true,
    app_server_started: true,
  },
  recovery: {},
}

function run(name, patch, expectedCode, expectedReason) {
  const evidence = structuredClone(base)
  Object.assign(evidence, patch)
  const file = path.join(temp, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedCode, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason, name)
}

run("healthy", {}, 0, "linux_cwd_continuity_verified")

run("unreachable-not-recovered", {
  runtime: { ...base.runtime, cwd_raw: "(unreachable)/home/user/src", nested_mount_namespace: true },
  startup: { app_server_requested: true, app_server_started: false, config_load_error: "No such file or directory (os error 2)" },
  recovery: { checkpoint_preserved: true },
}, 75, "unreachable_cwd_startup_state_unreconciled")

run("same-namespace-recovered", {
  runtime: { ...base.runtime, cwd_raw: "(unreachable)/home/user/src", nested_mount_namespace: true },
  startup: { app_server_requested: true, app_server_started: false, config_load_error: "ENOENT" },
  recovery: {
    continuation_route: "same_namespace_explicit_chdir",
    explicit_chdir_inside_namespace: true,
    canonical_cwd_verified: true,
    config_paths_readable: true,
    startup_canary_passed: true,
    canonical_turn_state_reconciled: true,
    external_writes_reconciled: true,
    checkpoint_preserved: true,
  },
}, 0, "same_namespace_explicit_chdir_verified")

run("approved-linux-route", {
  runtime: { ...base.runtime, cwd_raw: "(unreachable)/home/user/src", nested_mount_namespace: true },
  startup: { app_server_requested: true, app_server_started: false, current_dir_error: "os error 2" },
  recovery: {
    continuation_route: "approved_linux",
    approved_executor_verified: true,
    canonical_cwd_verified: true,
    startup_canary_passed: true,
    canonical_turn_state_reconciled: true,
    external_writes_reconciled: true,
    checkpoint_preserved: true,
  },
}, 0, "approved_executor_cwd_recovery_verified")

run("prefix-strip-rejected", {
  runtime: { ...base.runtime, cwd_raw: "(unreachable)/home/user/src", nested_mount_namespace: true },
  startup: { app_server_requested: true, app_server_started: false, config_load_error: "ENOENT" },
  recovery: { path_prefix_stripped_without_reanchor: true },
}, 64, "unsafe_unreachable_cwd_recovery_forbidden")

run("nsenter-wd-only-rejected", {
  runtime: { ...base.runtime, cwd_raw: "(unreachable)/home/user/src", nested_mount_namespace: true },
  startup: { app_server_requested: true, app_server_started: false, config_load_error: "ENOENT" },
  recovery: { inherited_or_nsenter_wd_only: true },
}, 64, "unsafe_unreachable_cwd_recovery_forbidden")

run("prohibited-route", {
  recovery: { continuation_route: "gateway-auto-select" },
}, 64, "prohibited_route_metadata")

fs.rmSync(temp, { recursive: true, force: true })
console.log("codex linux unreachable cwd continuity guard self-test passed")
