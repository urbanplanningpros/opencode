import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rehydrate-"))
const taskId = "task-test"
const taskDir = path.join(root, "tasks", taskId)
fs.mkdirSync(taskDir, { recursive: true })

fs.writeFileSync(
  path.join(taskDir, "manifest.json"),
  `${JSON.stringify(
    {
      task_id: taskId,
      operation_id: "op-test",
      idempotency_key: "idem-test",
      objective: "Continue the verified operator task after compaction.",
      acceptance_criteria: ["Preserve state", "Do not duplicate writes"],
      risk: "medium",
      write_intent: true,
      prohibited_actions: ["deploy directly to production"],
      route_identity: {
        approved_providers: ["openai", "local"],
        approved_models: ["gpt-approved", "local-approved"],
      },
    },
    null,
    2,
  )}\n`,
)
fs.writeFileSync(
  path.join(taskDir, "current-state.json"),
  `${JSON.stringify(
    {
      task_id: taskId,
      status: "running",
      active_provider: "openai",
      attempts: [],
      external_write_verified: false,
    },
    null,
    2,
  )}\n`,
)
fs.writeFileSync(path.join(taskDir, "decisions.json"), '[{"decision":"Use provider-neutral state"}]\n')
fs.writeFileSync(path.join(taskDir, "changed-files.json"), '["src/example.ts"]\n')
fs.writeFileSync(path.join(taskDir, "continuation-prompt.md"), "# Continuation\n\nResume from the verified manifest.\n")

const script = path.resolve(import.meta.dirname, "codex-post-compact-rehydrate.mjs")
const ok = spawnSync(process.execPath, [script, "--task-id", taskId, "--state-dir", root, "--json"], {
  encoding: "utf8",
})
assert.equal(ok.status, 0, ok.stderr)
const result = JSON.parse(ok.stdout)
assert.equal(result.task_id, taskId)
assert.equal(result.safe_to_continue, true)
assert.ok(fs.existsSync(result.context_path))
const context = fs.readFileSync(result.context_path, "utf8")
assert.match(context, /Continue the verified operator task after compaction/)
assert.match(context, /Reconcile any uncertain external write before replay/)

const currentFile = path.join(taskDir, "current-state.json")
const current = JSON.parse(fs.readFileSync(currentFile, "utf8"))
current.active_provider = "automatic-model-gateway"
fs.writeFileSync(currentFile, `${JSON.stringify(current, null, 2)}\n`)
const denied = spawnSync(process.execPath, [script, "--task-id", taskId, "--state-dir", root, "--json"], {
  encoding: "utf8",
})
assert.equal(denied.status, 2)
assert.match(denied.stderr, /Unapproved active provider|Prohibited provider/)

fs.rmSync(root, { recursive: true, force: true })
console.log("codex post-compaction rehydration self-test passed")
