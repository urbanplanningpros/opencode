#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-task-convergence-"))
const guard = new URL("./codex-task-convergence-guard.mjs", import.meta.url)
const hash = "b".repeat(64)

function run(name, evidence) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  const result = spawnSync(process.execPath, [guard.pathname, "--input", file, "--json"], { encoding: "utf8" })
  let output = null
  try {
    output = JSON.parse(result.stdout)
  } catch {}
  return { ...result, output }
}

const base = {
  task_id: "task-1",
  operation_id: "operation-1",
  route: "openai",
  completion_criteria_sha256: hash,
  current_completion_criteria_sha256: hash,
  subagents_enabled: false,
  stop_requested: false,
  external_write_outcome: "none",
  external_write_reconciled: true,
  limits: {
    max_elapsed_seconds: 3600,
    max_correction_cycles: 3,
    max_consecutive_nonreducing_cycles: 2,
  },
  progress: {
    elapsed_seconds: 600,
    correction_cycles: 1,
    consecutive_nonreducing_cycles: 0,
    new_work_items_this_cycle: 0,
    new_subagents_started: 0,
    remaining_item_ids: ["test-build"],
    completed_item_ids: ["implement"],
  },
}

const healthy = run("healthy", base)
assert.equal(healthy.status, 0, healthy.stderr || healthy.stdout)
assert.equal(healthy.output?.admitted, true)
assert.equal(healthy.output?.terminal, undefined)

const bounded = run("bounded", {
  ...base,
  progress: { ...base.progress, correction_cycles: 3, completed_item_ids: [] },
})
assert.equal(bounded.status, 75, bounded.stderr || bounded.stdout)
assert.equal(bounded.output?.admitted, false)

const snapshot = run("snapshot", {
  ...base,
  stop_requested: true,
  progress: { ...base.progress, completed_item_ids: [] },
  terminal_snapshot: {
    created: true,
    diff_manifest_sha256: "c".repeat(64),
    repository_dirty: false,
    repository_write_authorized: true,
    commit_sha: "d".repeat(40),
    branch: "fix/task-snapshot",
    draft_pr_url: "https://github.com/urbanplanningpros/opencode/pull/999",
    state_persisted_outside_model_memory: true,
    no_new_work_after_snapshot: true,
  },
})
assert.equal(snapshot.status, 0, snapshot.stderr || snapshot.stdout)
assert.equal(snapshot.output?.terminal, true)

const drift = run("criteria-drift", {
  ...base,
  current_completion_criteria_sha256: "e".repeat(64),
})
assert.equal(drift.status, 64, drift.stderr || drift.stdout)

const subagents = run("subagents", {
  ...base,
  subagents_enabled: true,
})
assert.equal(subagents.status, 64, subagents.stderr || subagents.stdout)

const uncertainWrite = run("uncertain-write", {
  ...base,
  stop_requested: true,
  external_write_outcome: "uncertain",
  external_write_reconciled: false,
})
assert.equal(uncertainWrite.status, 64, uncertainWrite.stderr || uncertainWrite.stdout)

const prohibited = run("prohibited", {
  ...base,
  route_note: "automatic gateway selector",
})
assert.equal(prohibited.status, 64, prohibited.stderr || prohibited.stdout)

fs.rmSync(root, { recursive: true, force: true })
console.log("codex task convergence guard self-test passed")
