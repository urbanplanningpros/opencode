import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-computer-use-disable-continuity-guard.mjs")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cua-disable-guard-"))

function baseEvidence() {
  return {
    operation_id: "op-cua-001",
    computer_use: {
      platform: "windows",
      app_version: "26.721.41059",
      user_disabled: true,
      workspace_disabled: false,
      plugin_disabled: true,
      runtime_capability_registered: false,
      action_observed_after_disable: false,
      disable_readback_verified: true,
      fresh_process_verified: true,
      pending_actions: 0,
      requested_action_count: 0,
    },
    containment: {
      only_cua_route_isolated: true,
      executor_stopped: true,
      capability_catalog_refreshed: true,
      os_permission_revoked: true,
      network_boundary_applied: false,
      kill_switch_receipt: "sha256:abc",
      broad_host_shutdown_requested: false,
    },
    state: {
      task_state_preserved: true,
      external_writes_reconciled: true,
      replay_requested: false,
      replacement_thread_requested: false,
    },
    continuity_route: {
      type: "direct_openai_cli",
      verified: true,
      canary_passed: true,
      operation_binding_matches: true,
      computer_use_absent: true,
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

runCase("healthy-disabled", () => {}, 0, "computer_use_policy_and_runtime_agree")
runCase("action-after-disable", (e) => { e.computer_use.action_observed_after_disable = true }, 77, "computer_use_executed_after_disable")
runCase("registered-after-disable", (e) => { e.computer_use.runtime_capability_registered = true }, 77, "computer_use_capability_remains_registered_while_disabled")
runCase("missing-readback", (e) => { e.computer_use.disable_readback_verified = false }, 75, "computer_use_disable_not_proven_at_runtime_boundary")
runCase("pending-actions", (e) => { e.computer_use.pending_actions = 2 }, 75, "pending_computer_use_actions_exist_after_disable")
runCase("route-not-ready", (e) => { e.computer_use.requested_action_count = 1; e.continuity_route.canary_passed = false }, 75, "disabled_computer_use_request_requires_verified_non_cua_continuity_route")
runCase("broad-shutdown", (e) => { e.containment.broad_host_shutdown_requested = true }, 64, "broad_host_shutdown_rejected")
runCase("replay-before-reconcile", (e) => { e.state.replay_requested = true; e.state.external_writes_reconciled = false }, 64, "replay_or_replacement_rejected_before_write_reconciliation")
runCase("prohibited-route", (e) => { e.continuity_route.type = "model_gateway" }, 64, "prohibited_route_metadata")
runCase("enabled-normal", (e) => { e.computer_use.user_disabled = false; e.computer_use.plugin_disabled = false; e.computer_use.disable_readback_verified = false; e.computer_use.fresh_process_verified = false; e.containment.only_cua_route_isolated = false }, 0, "computer_use_policy_and_runtime_agree")

fs.rmSync(tempDir, { recursive: true, force: true })
console.log("codex-computer-use-disable-continuity-guard: 10 fixtures passed")
