import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-completion-"))
const script = path.join(import.meta.dirname, "codex-appserver-turn-completion-guard.mjs")

const base = {
  schema_version: 1,
  turn_id: "turn-test",
  turn_completed_seen: false,
  final_assistant_output_seen: true,
  artifact_required: true,
  artifact_verified: true,
  external_write_attempted: false,
  destination_verified: false,
  tool_requests_total: 3,
  tool_results_accepted: 3,
  outstanding_tool_requests: 0,
  outstanding_server_requests: 0,
  outstanding_approvals: 0,
  outstanding_protocol_items: 0,
  outstanding_subagents: 0,
  owned_background_processes: 0,
  seconds_since_last_event: 10,
}

function run(name, snapshot) {
  const directory = path.join(root, name)
  const input = path.join(directory, "snapshot.json")
  const evidence = path.join(directory, "evidence")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(input, `${JSON.stringify(snapshot, null, 2)}\n`)
  const result = spawnSync(process.execPath, [script, "--input", input, "--evidence-dir", evidence, "--json"], {
    encoding: "utf8",
  })
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null }
}

const protocol = run("protocol", { ...base, turn_completed_seen: true })
assert.equal(protocol.status, 0, protocol.stderr)
assert.equal(protocol.json.status, "protocol_complete")
assert.equal(protocol.json.synthetic_local_completion, false)

const local = run("local", base)
assert.equal(local.status, 0, local.stderr)
assert.equal(local.json.status, "verified_completion_without_terminal_event")
assert.equal(local.json.synthetic_local_completion, true)
assert.equal(local.json.automatic_retry_allowed, false)
assert.ok(fs.existsSync(local.json.evidence_file))

const verifiedWrite = run("verified-write", {
  ...base,
  external_write_attempted: true,
  destination_verified: true,
})
assert.equal(verifiedWrite.status, 0, verifiedWrite.stderr)
assert.equal(verifiedWrite.json.status, "verified_completion_without_terminal_event")

const uncertainWrite = run("uncertain-write", {
  ...base,
  external_write_attempted: true,
  destination_verified: false,
})
assert.equal(uncertainWrite.status, 75, uncertainWrite.stderr)
assert.equal(uncertainWrite.json.status, "write_reconciliation_required")
assert.equal(uncertainWrite.json.requires_destination_reconciliation, true)

const unfinished = run("unfinished", {
  ...base,
  tool_results_accepted: 2,
  outstanding_tool_requests: 1,
  seconds_since_last_event: 1,
})
assert.equal(unfinished.status, 75, unfinished.stderr)
assert.equal(unfinished.json.status, "terminal_state_not_proven")

const malformed = run("malformed", { ...base, outstanding_tool_requests: -1 })
assert.equal(malformed.status, 2)
assert.match(malformed.stderr, /non-negative integer/)

fs.rmSync(root, { recursive: true, force: true })
console.log("codex-appserver-turn-completion-guard self-test passed")
