import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-automation-paused-create-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-paused-create-"))

const base = {
  operation_id: "op-automation-1",
  automation: {
    id: "automation-1",
    mode: "create",
    requested_status: "PAUSED",
    persisted_status: "PAUSED",
    post_create_readback: true,
    stored_payload_hash: "sha256:abc",
    requested_payload_hash: "sha256:abc",
    next_trigger_known: true,
    next_trigger_imminent: false,
  },
  correction: {
    attempted: false,
    full_read_modify_write_used: false,
    non_status_fields_preserved: false,
    corrected_status_readback: "",
    scheduler_suppressed_until_verified: true,
  },
  state: {
    task_state_preserved: true,
    external_writes_reconciled: true,
    automatic_enable_accepted: false,
    blind_retry_requested: false,
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

run("paused-create-safe", structuredClone(base), 0, "automation_create_status_verified")

const noReadback = structuredClone(base)
noReadback.automation.post_create_readback = false
run("require-readback", noReadback, 75, "automation_create_requires_persisted_status_readback")

const active = structuredClone(base)
active.automation.persisted_status = "ACTIVE"
run("paused-became-active", active, 75, "paused_automation_was_persisted_active")

const corrected = structuredClone(active)
corrected.correction.attempted = true
corrected.correction.full_read_modify_write_used = true
corrected.correction.non_status_fields_preserved = true
corrected.correction.corrected_status_readback = "PAUSED"
corrected.correction.scheduler_suppressed_until_verified = false
run("correction-needs-suppression-receipt", corrected, 75, "automation_status_corrected_without_scheduler_suppression_receipt")

const correctedSafe = structuredClone(corrected)
correctedSafe.correction.scheduler_suppressed_until_verified = true
run("corrected-paused-mismatch-still-detected", correctedSafe, 75, "automation_persisted_state_differs_from_requested_state")

const hashMismatch = structuredClone(base)
hashMismatch.automation.stored_payload_hash = "sha256:def"
run("reject-payload-hash-mismatch", hashMismatch, 75, "automation_payload_readback_hash_mismatch")

const blindRetry = structuredClone(base)
blindRetry.state.blind_retry_requested = true
blindRetry.state.external_writes_reconciled = false
run("reject-blind-retry", blindRetry, 64, "automation_retry_or_enable_rejected_before_reconciliation")

const imminent = structuredClone(base)
imminent.automation.next_trigger_imminent = true
imminent.correction.scheduler_suppressed_until_verified = false
run("suppress-imminent-paused-trigger", imminent, 75, "imminent_trigger_requires_specific_automation_suppression")

const activeRequested = structuredClone(base)
activeRequested.automation.requested_status = "ACTIVE"
activeRequested.automation.persisted_status = "ACTIVE"
run("active-create-safe", activeRequested, 0, "automation_create_status_verified")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
