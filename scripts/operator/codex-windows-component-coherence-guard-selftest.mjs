import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-windows-component-coherence-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-component-coherence-"))

const base = {
  task_id: "task-1",
  operation_id: "op-1",
  idempotency_key: "idem-1",
  components: {
    version_json: "0.146.0",
    command_runner_version: "0.146.0",
    runtime_package_version: "26.723.12215",
    component_set_coherent: true,
    component_skew_observed: false,
    release_manifest_verified: true,
    package_hashes_verified: true,
  },
  crash: {
    exception_code: "",
    fault_module: "",
    same_signature_count: 0,
    process_became_unresponsive: false,
  },
  recovery: {
    canonical_task_state_reconciled: true,
    repository_state_reconciled: true,
    external_writes_reconciled: true,
    unfinished_action_checkpointed: true,
    current_installation_preserved: true,
    automatic_task_replay_attempted: false,
    blind_auto_update_attempted: false,
    unverified_component_replacement_attempted: false,
    cold_start_canary_passed: true,
    repeated_crash_canary_passed: true,
    continuation_route: "verified_windows_bundle",
  },
}

const run = (name, evidence, expectedCode, expectedReason) => {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("healthy", structuredClone(base), 0, "windows_component_set_verified")

const skew = structuredClone(base)
skew.components.version_json = "0.143.0"
skew.components.command_runner_version = "0.146.0-alpha.3.1"
skew.components.component_set_coherent = false
skew.components.component_skew_observed = true
skew.components.release_manifest_verified = false
skew.components.package_hashes_verified = false
skew.recovery.canonical_task_state_reconciled = false
skew.recovery.continuation_route = ""
run("skew-unreconciled", skew, 75, "windows_codex_component_skew_unreconciled")

const skewRerouted = structuredClone(skew)
skewRerouted.recovery.canonical_task_state_reconciled = true
skewRerouted.recovery.continuation_route = "approved_linux"
run("skew-rerouted", skewRerouted, 0, "windows_execution_rerouted_after_reconciliation")

const crash = structuredClone(base)
crash.crash.exception_code = "0xc0000409"
crash.crash.fault_module = "codex.exe"
crash.crash.same_signature_count = 3
crash.recovery.repeated_crash_canary_passed = false
run("crash-native-unverified", crash, 75, "windows_codex_crash_state_unreconciled")

const crashRerouted = structuredClone(crash)
crashRerouted.recovery.continuation_route = "approved_local"
run("crash-rerouted", crashRerouted, 0, "windows_execution_rerouted_after_reconciliation")

const blindReplay = structuredClone(skew)
blindReplay.recovery.automatic_task_replay_attempted = true
run("blind-replay", blindReplay, 64, "blind_replay_or_component_replacement_forbidden")

const prohibited = structuredClone(base)
prohibited.recovery.continuation_route = "gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 7 }, null, 2))
