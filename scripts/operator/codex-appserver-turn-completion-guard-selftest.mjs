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
  parent_turn_id: "turn-root",
  expected_parent_turn_id: "turn-root",
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
assert.equal(protocol.json.parent_turn_id, "turn-root")

const local = run("local", base)
assert.equal(local.status, 0, local.stderr)
assert.equal(local.json.status, "verified_completion_without_terminal_event")
assert.equal(local.json.synthetic_local_completion, true)
assert.equal(local.json.automatic_retry_allowed, false)
assert.equal(local.json.checks.parent_turn_lineage_matched, true)
assert.ok(fs.existsSync(local.json.evidence_file))

const legacyWithoutLineage = structuredClone(base)
delete legacyWithoutLineage.parent_turn_id
delete legacyWithoutLineage.expected_parent_turn_id
const legacyResult = run("legacy-without-lineage", legacyWithoutLineage)
assert.equal(legacyResult.status, 0, legacyResult.stderr)
assert.equal(legacyResult.json.status, "verified_completion_without_terminal_event")

const lineageMismatch = run("lineage-mismatch", {
  ...base,
  parent_turn_id: "turn-other",
})
assert.equal(lineageMismatch.status, 75, lineageMismatch.stderr)
assert.equal(lineageMismatch.json.status, "turn_lineage_mismatch")
assert.equal(lineageMismatch.json.checks.parent_turn_lineage_matched, false)
assert.equal(lineageMismatch.json.automatic_retry_allowed, false)

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
