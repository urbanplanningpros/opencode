import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-windows-desktop-bootstrap-continuity-guard.mjs")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-bootstrap-guard-"))

function baseEvidence() {
  return {
    operation_id: "op-win-001",
    desktop: {
      platform: "windows",
      package_version: "26.721.11231.0",
      signature_valid: true,
      launch_attempted: true,
      exit_code: "0",
      chromium_initialized: true,
      sandbox_setup_launched: true,
      sandbox_setup_succeeded: true,
      clean_profile_tested: true,
      reinstall_count: 0,
      corrected_build: true,
      cold_start_canary_passed: true,
      sandbox_canary_passed: true,
      multi_task_restart_canary_passed: true,
    },
    state: {
      task_state_preserved: true,
      external_writes_reconciled: true,
      reinstall_requested: false,
      app_state_deletion_requested: false,
      broad_host_shutdown_requested: false,
    },
    continuity_route: {
      type: "direct_openai_cli",
      verified: true,
      canary_passed: true,
      operation_binding_matches: true,
      workspace_head_verified: true,
    },
  }
}

function runCase(name, mutate, expectedCode, expectedReason) {
  const evidence = baseEvidence()
  mutate(evidence)
  const file = path.join(tempDir, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedCode, `${name}: ${result.stderr || result.stdout}`)
  const output = JSON.parse((result.stdout || result.stderr).trim())
  assert.equal(output.reason, expectedReason, name)
}

runCase("healthy", () => {}, 0, "windows_desktop_bootstrap_verified")
runCase("broad-shutdown", (e) => { e.state.broad_host_shutdown_requested = true }, 64, "broad_host_shutdown_rejected")
runCase("unsafe-delete", (e) => { e.state.app_state_deletion_requested = true; e.state.external_writes_reconciled = false }, 64, "destructive_app_state_recovery_rejected_before_reconciliation")
runCase("blind-reinstall", (e) => { e.desktop.chromium_initialized = false; e.desktop.exit_code = "0xC0000001"; e.desktop.corrected_build = false; e.state.reinstall_requested = true; e.desktop.reinstall_count = 2 }, 77, "blind_reinstall_loop_rejected")
runCase("failure-unreconciled", (e) => { e.desktop.chromium_initialized = false; e.desktop.exit_code = "0xC0000001"; e.desktop.corrected_build = false; e.state.external_writes_reconciled = false }, 75, "desktop_failure_requires_state_and_write_reconciliation")
runCase("failure-no-route", (e) => { e.desktop.chromium_initialized = false; e.desktop.exit_code = "0xC0000001"; e.desktop.corrected_build = false; e.continuity_route.canary_passed = false }, 75, "desktop_unavailable_without_verified_continuity_route")
runCase("failure-rerouted", (e) => { e.desktop.chromium_initialized = false; e.desktop.exit_code = "0xC0000001"; e.desktop.corrected_build = false }, 77, "windows_desktop_surface_quarantined")
runCase("sandbox-failure", (e) => { e.desktop.sandbox_setup_succeeded = false; e.desktop.corrected_build = false }, 77, "windows_desktop_surface_quarantined")
runCase("resume-canary-missing", (e) => { e.desktop.multi_task_restart_canary_passed = false }, 75, "desktop_resume_canaries_incomplete")
runCase("unapproved-route", (e) => { e.continuity_route.type = "unapproved_route"; e.desktop.chromium_initialized = false; e.desktop.exit_code = "0xC0000001"; e.desktop.corrected_build = false }, 75, "desktop_unavailable_without_verified_continuity_route")

fs.rmSync(tempDir, { recursive: true, force: true })
console.log("codex-windows-desktop-bootstrap-continuity-guard: 10 fixtures passed")
