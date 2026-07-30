import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-plan-mode-resume-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-resume-"))

const base = {
  task_id: "task-1",
  operation_id: "op-1",
  thread_id: "thread-1",
  requested_mode: "default",
  client_mode: "default",
  tool_mode: "default",
  injected_mode: "default",
  resume: {
    used: true,
    crossed_cli_version: true,
    source_cli_version: "0.144.5",
    resumed_cli_version: "0.146.0",
  },
  recovery: {
    source_thread_preserved: true,
    state_snapshot_hashed: true,
    repository_state_reconciled: true,
    external_writes_reconciled: true,
    mutation_blocked_in_affected_thread: false,
    checkpoint_exported: false,
    fresh_default_thread_created: false,
    automatic_replay_attempted: false,
    fork_or_continue_used: false,
    continuation_route: "same_thread",
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("healthy-resume", structuredClone(base), 0, "plan_mode_resume_continuity_verified")

const stale = structuredClone(base)
stale.tool_mode = "plan"
stale.injected_mode = "plan"
run("stale-unreconciled", stale, 75, "stale_plan_mode_state_unreconciled")

const recovered = structuredClone(stale)
recovered.recovery.mutation_blocked_in_affected_thread = true
recovered.recovery.checkpoint_exported = true
recovered.recovery.fresh_default_thread_created = true
recovered.recovery.continuation_route = "fresh_default_thread"
run("stale-rerouted", recovered, 0, "stale_plan_mode_isolated_and_rerouted")

const split = structuredClone(base)
split.tool_mode = "plan"
run("mode-split", split, 75, "stale_plan_mode_state_unreconciled")

const replay = structuredClone(recovered)
replay.recovery.automatic_replay_attempted = true
run("automatic-replay", replay, 64, "replay_or_inherited_thread_continuation_forbidden")

const forked = structuredClone(recovered)
forked.recovery.fork_or_continue_used = true
run("fork-inherits-stale-state", forked, 64, "replay_or_inherited_thread_continuation_forbidden")

const prohibited = structuredClone(base)
prohibited.recovery.continuation_route = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 7 }, null, 2))
