import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-collaboration-message-replay-guard.mjs")
const hash = "a".repeat(64)

function baseEvidence() {
  return {
    route: "direct_openai",
    tool: "spawn_agent",
    arguments_sha256: hash,
    original_marker: { field_present: true, item_count: 0 },
    replay_marker: { field_present: true, item_count: 0 },
    delivery: "structured_plaintext_agent_message",
    lineage: {
      root_turn_id: "root-1",
      turn_id: "turn-2",
      parent_turn_id: "turn-1",
      expected_parent_turn_id: "turn-1",
      authorized: true,
    },
    logging: {
      tool_arguments_redacted: true,
      communication_payload_redacted: true,
      raw_arguments_persisted: false,
    },
    downstream: { non_openai_metadata_forwarded: false },
  }
}

function run(evidence) {
  return spawnSync(process.execPath, [guard, "--json"], {
    input: JSON.stringify(evidence),
    encoding: "utf8",
    timeout: 10000,
  })
}

const plaintext = run(baseEvidence())
assert.equal(plaintext.status, 0, plaintext.stderr)
assert.equal(JSON.parse(plaintext.stdout).normalized.marker_mode, "plaintext_structured")

const droppedEmptyMarker = baseEvidence()
droppedEmptyMarker.replay_marker = { field_present: false, item_count: 0 }
const droppedResult = run(droppedEmptyMarker)
assert.equal(droppedResult.status, 64)
assert.match(droppedResult.stdout, /preserve encrypted_function_args/)

const encrypted = baseEvidence()
encrypted.original_marker = { field_present: true, item_count: 2 }
encrypted.replay_marker = { field_present: true, item_count: 2 }
encrypted.delivery = "encrypted_agent_message"
const encryptedResult = run(encrypted)
assert.equal(encryptedResult.status, 0, encryptedResult.stderr)

const leakedLog = baseEvidence()
leakedLog.logging.raw_arguments_persisted = true
const leakedLogResult = run(leakedLog)
assert.equal(leakedLogResult.status, 64)
assert.match(leakedLogResult.stdout, /raw_arguments_persisted/)

const wrongLineage = baseEvidence()
wrongLineage.lineage.expected_parent_turn_id = "turn-other"
const wrongLineageResult = run(wrongLineage)
assert.equal(wrongLineageResult.status, 64)
assert.match(wrongLineageResult.stdout, /does not match/)

const wrongDelivery = baseEvidence()
wrongDelivery.delivery = "encrypted_agent_message"
const wrongDeliveryResult = run(wrongDelivery)
assert.equal(wrongDeliveryResult.status, 64)
assert.match(wrongDeliveryResult.stdout, /structured_plaintext_agent_message/)

const prohibited = baseEvidence()
prohibited.route = "provider-gateway"
const prohibitedResult = run(prohibited)
assert.equal(prohibitedResult.status, 64)
assert.match(prohibitedResult.stdout, /excluded provider/)

console.log("Codex collaboration message replay guard self-test passed")
