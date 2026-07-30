import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-windows-ipc-continuity-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-ipc-continuity-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason)
}

const base = {
  task_id: "task-35985",
  operation_id: "operation-35985",
  platform: "Windows 11 x64",
  desktop_build: "26.721.4979.0",
  browser_integration_enabled: false,
  browser_route_disabled: true,
  long_running_task: false,
  concurrent_task_count: 1,
  browser_sidebar_client_closed: false,
  epipe_observed: false,
  write_eof_uncaught: false,
  app_server_disconnected: false,
  canonical_task_state: "active",
  uncertain_writes_reconciled: true,
  interrupted_turn_reconciled: true,
  child_processes_inventoried: true,
  automatic_replay_attempted: false,
  system_wide_input_lag_observed: false,
  powershell_wmi_snapshot_children_observed: false,
  wmi_snapshot_rate_per_second: 0,
  wmi_activity_error_observed: false,
  desktop_execution_isolated: false,
  unsafe_wmi_suppression_applied: false,
  crypt_unprotect_data_failure_observed: false,
  dpapi_error_code: "",
  sandbox_command_dispatch_state: "none",
  native_windows_sandbox_isolated: false,
  unsafe_dpapi_repair_attempted: false,
  reroute_target: "approved_linux_vps",
}

run("safe", base, 0, "windows_ipc_continuity_verified")
run(
  "affected-preflight",
  {
    ...base,
    browser_integration_enabled: true,
    browser_route_disabled: false,
    long_running_task: true,
  },
  75,
  "affected_windows_browser_ipc_route_not_isolated",
)
run(
  "uncertain-write",
  {
    ...base,
    epipe_observed: true,
    app_server_disconnected: true,
    uncertain_writes_reconciled: false,
  },
  75,
  "uncertain_writes_not_reconciled",
)
run(
  "unknown-state",
  {
    ...base,
    write_eof_uncaught: true,
    app_server_disconnected: true,
    canonical_task_state: "unknown",
  },
  75,
  "canonical_task_state_unknown_after_ipc_failure",
)
run(
  "orphan-inventory",
  {
    ...base,
    epipe_observed: true,
    app_server_disconnected: true,
    child_processes_inventoried: false,
  },
  75,
  "orphan_child_process_inventory_required",
)
run(
  "unsafe-replay",
  {
    ...base,
    epipe_observed: true,
    app_server_disconnected: true,
    automatic_replay_attempted: true,
  },
  64,
  "automatic_replay_forbidden_after_ipc_failure",
)
run(
  "wmi-pressure",
  {
    ...base,
    desktop_build: "26.721.11231.0",
    system_wide_input_lag_observed: true,
    powershell_wmi_snapshot_children_observed: true,
    wmi_snapshot_rate_per_second: 1.2,
    desktop_execution_isolated: false,
  },
  75,
  "windows_wmi_snapshot_pressure_not_isolated",
)
run(
  "wmi-contained",
  {
    ...base,
    desktop_build: "26.721.11231.0",
    system_wide_input_lag_observed: true,
    powershell_wmi_snapshot_children_observed: true,
    wmi_snapshot_rate_per_second: 1.2,
    desktop_execution_isolated: true,
  },
  0,
  "windows_wmi_snapshot_pressure_contained",
)
run(
  "unsafe-wmi-suppression",
  {
    ...base,
    desktop_build: "26.721.11231.0",
    unsafe_wmi_suppression_applied: true,
  },
  64,
  "unsafe_wmi_snapshot_suppression_forbidden",
)
run(
  "dpapi-non-dispatch-unknown",
  {
    ...base,
    crypt_unprotect_data_failure_observed: true,
    dpapi_error_code: "0x8009000B",
    sandbox_command_dispatch_state: "unknown",
    native_windows_sandbox_isolated: true,
  },
  75,
  "dpapi_failed_command_non_dispatch_not_proven",
)
run(
  "dpapi-not-isolated",
  {
    ...base,
    crypt_unprotect_data_failure_observed: true,
    dpapi_error_code: "2148073483",
    sandbox_command_dispatch_state: "not_dispatched",
    native_windows_sandbox_isolated: false,
  },
  75,
  "windows_dpapi_sandbox_failure_not_isolated",
)
run(
  "dpapi-contained",
  {
    ...base,
    crypt_unprotect_data_failure_observed: true,
    dpapi_error_code: "NTE_BAD_KEY_STATE",
    sandbox_command_dispatch_state: "not_dispatched",
    native_windows_sandbox_isolated: true,
  },
  0,
  "windows_dpapi_sandbox_failure_contained",
)
run(
  "unsafe-dpapi-repair",
  {
    ...base,
    crypt_unprotect_data_failure_observed: true,
    dpapi_error_code: "0x8009000B",
    sandbox_command_dispatch_state: "not_dispatched",
    unsafe_dpapi_repair_attempted: true,
  },
  64,
  "unsafe_dpapi_repair_forbidden",
)
run(
  "prohibited-route",
  {
    ...base,
    reroute_target: "automatic model gateway selector",
  },
  64,
  "prohibited_route_metadata",
)

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Windows IPC continuity guard self-test passed")
