import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-remote-pairing-daemon-continuity-guard.mjs")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-pairing-guard-"))

function baseEvidence() {
  return {
    operation_id: "op-remote-001",
    pairing: {
      mobile_platform: "android",
      mobile_version: "1.2026.209 (12)",
      host_platform: "macos",
      cli_version: "0.146.0",
      browser_authorization_completed: true,
      returned_to_app: true,
      pairing_claims_seen: 1,
      host_websocket_connected: true,
      same_account_verified: true,
      fresh_pairing_code: true,
      authorization_attempts: 1,
      paired_device_readback: true,
    },
    daemon: {
      managed_daemon_expected: true,
      managed_daemon_running: true,
      control_socket_owned_by_managed_daemon: true,
      generic_app_server_present: false,
      auto_boot_suppressed: true,
      unrelated_codex_command_before_start: false,
    },
    recovery: {
      process_inventory_captured: true,
      exact_socket_owner_identified: true,
      only_stale_generic_server_stopped: true,
      managed_daemon_started_first: true,
      post_start_health_canary: true,
      repeated_auth_suppressed: true,
      broad_process_kill_requested: false,
    },
    state: {
      task_state_preserved: true,
      external_writes_reconciled: true,
      host_work_continues: true,
      thread_replay_requested: false,
      new_pairing_identity_requested: false,
    },
    continuity_route: {
      type: "direct_openai_cli",
      verified: true,
      canary_passed: true,
      operation_binding_matches: true,
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

runCase("healthy", () => {}, 0, "remote_pairing_and_daemon_state_verified")
runCase("authorization-loop", (e) => { e.pairing.pairing_claims_seen = 0; e.pairing.paired_device_readback = false }, 75, "mobile_authorization_completed_without_pairing_claim")
runCase("host-health-missing", (e) => { e.pairing.browser_authorization_completed = false; e.pairing.returned_to_app = false; e.pairing.host_websocket_connected = false }, 75, "host_remote_control_health_not_proven")
runCase("generic-server", (e) => { e.daemon.generic_app_server_present = true; e.daemon.managed_daemon_running = false; e.daemon.control_socket_owned_by_managed_daemon = false; e.recovery.post_start_health_canary = false }, 75, "generic_app_server_occupies_managed_control_socket")
runCase("autoboot-race", (e) => { e.daemon.unrelated_codex_command_before_start = true }, 75, "codex_command_retriggered_generic_auto_boot_before_daemon_start")
runCase("daemon-not-authoritative", (e) => { e.daemon.managed_daemon_running = false; e.daemon.control_socket_owned_by_managed_daemon = false; e.recovery.post_start_health_canary = false }, 75, "managed_remote_control_daemon_not_authoritative")
runCase("repeat-auth", (e) => { e.pairing.browser_authorization_completed = false; e.pairing.returned_to_app = false; e.pairing.authorization_attempts = 3; e.pairing.paired_device_readback = false; e.recovery.repeated_auth_suppressed = false }, 75, "repeated_authorization_attempts_suppressed")
runCase("broad-kill", (e) => { e.recovery.broad_process_kill_requested = true }, 64, "broad_codex_process_kill_rejected")
runCase("replay-before-reconcile", (e) => { e.state.thread_replay_requested = true; e.state.external_writes_reconciled = false }, 64, "remote_replay_or_identity_replacement_rejected_before_reconciliation")
runCase("prohibited-route", (e) => { e.continuity_route.type = "vertex_gateway" }, 64, "prohibited_route_metadata")

fs.rmSync(tempDir, { recursive: true, force: true })
console.log("codex-remote-pairing-daemon-continuity-guard: 10 fixtures passed")
