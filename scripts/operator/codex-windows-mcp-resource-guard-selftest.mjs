import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-windows-mcp-resource-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-mcp-resource-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const input = path.join(temporary, `${name}.json`)
  fs.writeFileSync(input, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason)
}

const base = {
  task_id: "task-36038",
  operation_id: "operation-36038",
  platform: "Windows 10 x64",
  desktop_build: "26.721.4979.0",
  routing: { provider: "openai", route: "direct" },
  active_task_count: 2,
  configured_stdio_mcp_server_count: 2,
  stdio_mcp_process_count: 4,
  duplicate_stdio_mcp_chains_observed: false,
  committed_memory_percent: 50,
  live_kernel_event_0x1cc_observed: false,
  system_hang_observed: false,
  unexpected_reboot_observed: false,
  automatic_stdio_mcp_startup_disabled: false,
  desktop_execution_isolated: false,
  mcp_process_inventory_complete: true,
  uncertain_writes_reconciled: true,
  bulk_process_kill_attempted: false,
  stdio_connection_closed: false,
  residual_stdio_app_server_processes: 0,
  residual_processes_bound_to_operation: true,
  wrapper_terminated_residual_app_server: true,
  app_server_exit_reason: "",
  pinned_stable_contains_stdio_close_fix: false,
}

run("safe", base, 0, "windows_mcp_resource_continuity_verified")

const pressure = {
  ...base,
  stdio_mcp_process_count: 12,
  duplicate_stdio_mcp_chains_observed: true,
  committed_memory_percent: 96,
  live_kernel_event_0x1cc_observed: true,
  system_hang_observed: true,
  unexpected_reboot_observed: true,
  automatic_stdio_mcp_startup_disabled: false,
  desktop_execution_isolated: false,
}
run("pressure", pressure, 75, "automatic_stdio_mcp_startup_must_be_disabled")

const contained = {
  ...pressure,
  automatic_stdio_mcp_startup_disabled: true,
  desktop_execution_isolated: true,
}
run("contained", contained, 0, "windows_mcp_resource_pressure_contained")

const missingInventory = {
  ...contained,
  mcp_process_inventory_complete: false,
}
run("inventory", missingInventory, 75, "mcp_process_inventory_required")

const unreconciled = {
  ...contained,
  uncertain_writes_reconciled: false,
}
run("unreconciled", unreconciled, 75, "uncertain_writes_not_reconciled_after_resource_failure")

const residual = {
  ...base,
  stdio_connection_closed: true,
  residual_stdio_app_server_processes: 1,
  residual_processes_bound_to_operation: true,
  wrapper_terminated_residual_app_server: false,
}
run("residual", residual, 75, "terminate_bound_residual_stdio_app_server")

const unboundResidual = {
  ...residual,
  residual_processes_bound_to_operation: false,
}
run("unbound-residual", unboundResidual, 75, "residual_stdio_app_server_not_bound_to_operation")

const stdioWatch = {
  ...base,
  stdio_connection_closed: true,
  residual_stdio_app_server_processes: 0,
  app_server_exit_reason: "last_connection_closed",
}
run("stdio-watch", stdioWatch, 0, "stdio_close_fix_not_in_pinned_stable_wrapper_watch_required")

const bulkKill = {
  ...contained,
  bulk_process_kill_attempted: true,
}
run("bulk-kill", bulkKill, 64, "bulk_process_kill_forbidden")

const prohibited = {
  ...base,
  routing: { provider: "openai", route: "automatic gateway" },
}
run("prohibited", prohibited, 64, "prohibited_route_metadata")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("Codex Windows MCP resource guard self-test passed")
