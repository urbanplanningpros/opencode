import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-remote-thread-create-idempotency-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-thread-create-idempotency-"))

const base = {
  operation_id: "op-thread-1",
  remote: {
    client: "codex_chatgpt_android_remote",
    connection_id: "connection-1",
    resume_count: 1,
    thread_start_count: 1,
  },
  creation: {
    call_id: "call-1",
    requested_count: 1,
    persisted_thread_ids: ["thread-1"],
    idempotency_key: "op-thread-1:create-thread",
    original_thread_id: "thread-1",
    dedupe_receipt_verified: true,
    call_binding_matches: true,
    automatic_replay_requested: false,
    replacement_thread_requested: false,
    duplicate_threads_quarantined: false,
    canonical_thread_preserved: true,
  },
  state: {
    task_state_preserved: true,
    external_writes_reconciled: true,
    thread_inventory_reconciled: true,
  },
  continuity_route: {
    type: "direct_openai_app_server",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  const parsed = JSON.parse(stream)
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("exactly-once", structuredClone(base), 0, "remote_thread_creation_idempotency_verified")

const repeatedResume = structuredClone(base)
repeatedResume.remote.resume_count = 7
run("repeated-resume-deduped", repeatedResume, 0, "remote_thread_creation_idempotency_verified")

const duplicate = structuredClone(base)
duplicate.remote.resume_count = 7
duplicate.remote.thread_start_count = 7
duplicate.creation.persisted_thread_ids = ["thread-1", "thread-2", "thread-3"]
duplicate.creation.duplicate_threads_quarantined = false
run("duplicate-needs-reconciliation", duplicate, 75, "duplicate_remote_threads_require_canonical_reconciliation")

const duplicateReconciled = structuredClone(duplicate)
duplicateReconciled.creation.duplicate_threads_quarantined = true
run("duplicate-detected-after-reconciliation", duplicateReconciled, 75, "remote_create_thread_replay_detected")

const noKey = structuredClone(base)
noKey.creation.idempotency_key = ""
run("reject-no-idempotency-key", noKey, 75, "side_effecting_thread_creation_lacks_idempotency_binding")

const noDedupe = structuredClone(base)
noDedupe.creation.dedupe_receipt_verified = false
run("reject-no-dedupe-receipt", noDedupe, 75, "side_effecting_thread_creation_lacks_idempotency_binding")

const missingStart = structuredClone(base)
missingStart.remote.thread_start_count = 0
missingStart.creation.persisted_thread_ids = []
run("reject-missing-start", missingStart, 75, "thread_start_and_persistence_receipts_do_not_prove_exactly_once_creation")

const replay = structuredClone(base)
replay.creation.automatic_replay_requested = true
replay.state.external_writes_reconciled = false
run("reject-replay-before-reconciliation", replay, 64, "thread_replay_or_replacement_rejected_before_reconciliation")

const multiRequest = structuredClone(base)
multiRequest.creation.requested_count = 2
run("reject-multi-create-operation", multiRequest, 64, "remote_create_thread_requires_single_logical_operation")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
