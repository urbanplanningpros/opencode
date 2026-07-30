#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-computer-use-"))
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-windows-computer-use-continuity-guard.mjs")

function run(name, evidence, expectedExit, expectedStatus) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedExit) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${name}: expected exit ${expectedExit}, got ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedStatus) throw new Error(`${name}: expected ${expectedStatus}, got ${output.status}`)
  return output
}

const base = {
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  task_id: "task-36091",
  operation_id: "operation-36091",
  idempotency_key: "idem-36091",
  platform: "Windows 11 x64",
  desktop_build: "26.721.4979.0",
  computer_use_runtime: "@oai/sky 0.5.2",
  active_turn: false,
  computer_use_process_running: false,
  system_wide_stutter_observed: false,
  controlled_ab_test_completed: false,
  stutter_absent_after_helper_stop: false,
  operation_requires_computer_use: false,
  computer_use_helper_stopped: false,
  exact_helper_stop_requested: false,
  computer_use_helper_pid: 0,
  helper_pid_bound_to_operation: false,
  generic_process_kill_requested: false,
  canonical_task_state: "active",
  uncertain_writes_reconciled: true,
  alternate_computer_use_executor_verified: false,
  desktop_retained_as_control_surface: true,
  reroute_target: "none",
}

try {
  run("healthy", base, 0, "compatible")

  const observed = structuredClone(base)
  Object.assign(observed, {
    active_turn: true,
    computer_use_process_running: true,
    system_wide_stutter_observed: true,
    computer_use_helper_pid: 4242,
    helper_pid_bound_to_operation: true,
  })
  const observedResult = run("observed-not-contained", observed, 75, "remediation_required")
  if (!observedResult.remediation.includes("run_controlled_computer_use_helper_ab_test")) {
    throw new Error("observed-not-contained: A/B test remediation missing")
  }

  const contained = structuredClone(observed)
  Object.assign(contained, {
    controlled_ab_test_completed: true,
    stutter_absent_after_helper_stop: true,
    exact_helper_stop_requested: true,
    computer_use_helper_stopped: true,
  })
  const containedResult = run("ordinary-work-contained", contained, 0, "compatible")
  if (!containedResult.incident_contained) throw new Error("ordinary-work-contained: incident not marked contained")

  const computerUseRequired = structuredClone(contained)
  Object.assign(computerUseRequired, {
    operation_requires_computer_use: true,
    alternate_computer_use_executor_verified: false,
    reroute_target: "none",
  })
  const requiredResult = run("computer-use-no-alternate", computerUseRequired, 64, "blocked")
  if (!requiredResult.blocked.includes("computer_use_operation_requires_verified_approved_alternate_executor")) {
    throw new Error("computer-use-no-alternate: missing alternate executor boundary")
  }

  const computerUseRerouted = structuredClone(computerUseRequired)
  Object.assign(computerUseRerouted, {
    alternate_computer_use_executor_verified: true,
    reroute_target: "authorized_local_linux",
  })
  run("computer-use-rerouted", computerUseRerouted, 0, "compatible")

  const genericKill = structuredClone(contained)
  genericKill.generic_process_kill_requested = true
  const genericKillResult = run("generic-kill", genericKill, 64, "blocked")
  if (!genericKillResult.blocked.includes("generic_process_kill_forbidden")) {
    throw new Error("generic-kill: generic process kill was not rejected")
  }

  const prohibitedRoute = structuredClone(base)
  prohibitedRoute.routing = { provider: "anthropic", route: "gateway", automatic_selector: true, model_gateway: true }
  run("prohibited-route", prohibitedRoute, 64, "blocked")

  console.log("Codex Windows Computer Use continuity guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
