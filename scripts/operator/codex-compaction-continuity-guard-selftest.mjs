import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compaction-continuity-"))
const guard = path.resolve("scripts/operator/codex-compaction-continuity-guard.mjs")
const base = {
  task_id: "task-20260729-001",
  completion_criteria_sha256: "criteria-sha256",
  checkpoint_id: "checkpoint-4",
  repository_sha: "repo-sha",
  diff_sha256: "diff-sha256",
  completed_steps_sha256: "completed-sha256",
  phase: "verification",
  next_action: "run final bounded test",
  completed_steps: ["inspect repository", "apply patch", "build application"],
  remaining_steps: ["run final bounded test", "publish completion report"],
  compaction_count: 1,
  repeated_command_count: 0,
  repeated_build_without_diff_count: 0,
  reopened_resolved_count: 0,
  duplicate_subagent_assignment_count: 0,
  completed_step_regression_count: 0,
  checkpoint_restored: true,
  repository_state_verified: true,
  uncertain_writes_reconciled: true,
  subagents_enabled: false,
  subagent_results_restored: false,
  restored_completion_criteria_sha256: "criteria-sha256",
  restored_completed_steps_sha256: "completed-sha256",
  restored_next_action: "run final bounded test",
  fresh_guarded_turn: false,
  continuation_state_persisted: true,
}

function run(name, payload, env = {}) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  const text = String(result.stdout || result.stderr || "").trim()
  return { status: result.status, output: text ? JSON.parse(text) : null }
}

try {
  const healthy = run("healthy", base)
  assert.equal(healthy.status, 0)
  assert.equal(healthy.output.reason, "compaction_continuity_verified")

  const regressed = run("regressed", { ...base, completed_step_regression_count: 1 })
  assert.equal(regressed.status, 75)
  assert.equal(regressed.output.reason, "completed_work_regressed_after_compaction")

  const repeating = run("repeating", { ...base, repeated_build_without_diff_count: 3 })
  assert.equal(repeating.status, 75)
  assert.equal(repeating.output.reason, "post_compaction_repetition_limit_reached")

  const incomplete = run("incomplete", { ...base, checkpoint_restored: false })
  assert.equal(incomplete.status, 75)
  assert.equal(incomplete.output.reason, "compaction_checkpoint_restoration_incomplete")

  const freshTurn = run("fresh-turn", {
    ...base,
    checkpoint_restored: false,
    repository_state_verified: false,
    restored_completion_criteria_sha256: "missing",
    restored_completed_steps_sha256: "missing",
    restored_next_action: "missing",
    fresh_guarded_turn: true,
    continuation_state_persisted: true,
  })
  assert.equal(freshTurn.status, 0)

  const subagentRoute = run("subagent-route", {
    ...base,
    subagents_enabled: true,
    subagent_results_restored: true,
  })
  assert.equal(subagentRoute.status, 75)
  assert.equal(subagentRoute.output.reason, "subagent_compaction_route_unattested")

  const prohibited = run("prohibited", base, { OPERATOR_ROUTE: "model-gateway-auto-select" })
  assert.equal(prohibited.status, 64)
  assert.equal(prohibited.output.reason, "prohibited_route_metadata")

  console.log("codex-compaction-continuity-guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
