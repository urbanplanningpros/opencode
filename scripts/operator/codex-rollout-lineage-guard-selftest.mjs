import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const script = path.join(import.meta.dirname, "codex-rollout-lineage-guard.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-lineage-"))
const sessions = path.join(root, "sessions", "2026", "07", "27")
fs.mkdirSync(sessions, { recursive: true })

function writeRollout(name, payload, extra = "") {
  const file = path.join(sessions, `${name}.jsonl`)
  fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload })}\n${extra}`, "utf8")
  return file
}

function run(extraArgs = []) {
  const proc = spawnSync(
    process.execPath,
    [script, "--codex-home", root, "--fork-warn-bytes", "1", "--fork-critical-bytes", "1000000", "--no-fail", ...extraArgs],
    { encoding: "utf8" },
  )
  assert.equal(proc.status, 0, proc.stderr)
  return JSON.parse(proc.stdout)
}

const parent = writeRollout("parent", {
  id: "parent-thread",
  history_mode: "paginated",
})
writeRollout("child-good", {
  id: "child-good",
  forked_from_id: "parent-thread",
  history_mode: "paginated",
  history_base: {
    thread_id: "parent-thread",
    end_ordinal_exclusive: 3,
    end_byte_offset: 128,
  },
})
writeRollout("child-risk", {
  id: "child-risk",
  forked_from_id: "parent-thread",
  history_mode: "paginated",
})

let result = run()
assert.equal(result.status, "warning")
assert.ok(result.findings.some((finding) => finding.code === "fork_materialized_without_history_base"))
assert.ok(!result.findings.some((finding) => finding.code === "history_base_parent_missing"))

fs.unlinkSync(parent)
result = run()
assert.equal(result.status, "critical")
assert.ok(result.findings.some((finding) => finding.code === "history_base_parent_missing"))

fs.rmSync(root, { recursive: true, force: true })
console.log("codex rollout lineage guard self-test passed")
