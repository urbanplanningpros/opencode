import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-goal-checkpoint-guard.mjs")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-checkpoint-guard-"))

function baseEvidence() {
  return {
    operation_id: "op-goal-001",
    goal: {
      elapsed_seconds: 1200,
      checkpoint_seconds: 3600,
      tokens_used: 500000,
      token_limit: 2000000,
      repeated_loop_count: 0,
      progress_delta: 1,
      compaction_count: 0,
      checkpoint_written: true,
      narrow_probe_defined: true,
      extension_authorized: false,
    },
    state: {
      task_state_preserved: true,
      external_writes_reconciled: true,
      replay_requested: false,
      replacement_goal_requested: false,
      broad_pause_requested: false,
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

runCase("healthy", () => {}, 0, "goal_checkpoint_policy_satisfied")
runCase("unsafe-replay", (e) => { e.state.replay_requested = true; e.state.external_writes_reconciled = false }, 64, "replay_rejected_before_reconciliation")
runCase("broad-pause", (e) => { e.state.broad_pause_requested = true }, 64, "broad_pause_rejected")
runCase("time-checkpoint", (e) => { e.goal.elapsed_seconds = 4000; e.goal.checkpoint_written = false }, 75, "checkpoint_required")
runCase("token-checkpoint", (e) => { e.goal.tokens_used = 3000000; e.goal.checkpoint_written = false }, 75, "checkpoint_required")
runCase("loop-checkpoint", (e) => { e.goal.repeated_loop_count = 4; e.goal.progress_delta = 0; e.goal.compaction_count = 2; e.goal.checkpoint_written = false }, 75, "checkpoint_required")
runCase("narrow-probe", (e) => { e.goal.repeated_loop_count = 4; e.goal.progress_delta = 0; e.goal.narrow_probe_defined = false }, 75, "narrow_probe_required")
runCase("extension", (e) => { e.goal.tokens_used = 3000000 }, 77, "extension_required")
runCase("state", (e) => { e.state.task_state_preserved = false }, 75, "state_reconciliation_required")
runCase("authorized-extension", (e) => { e.goal.tokens_used = 3000000; e.goal.extension_authorized = true }, 0, "goal_checkpoint_policy_satisfied")

fs.rmSync(tempDir, { recursive: true, force: true })
console.log("codex-goal-checkpoint-guard: 10 fixtures passed")
