import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-image-input-revision-guard.mjs")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-revision-guard-"))
const hash = "a".repeat(64)

function baseEvidence() {
  return {
    operation_id: "op-image-001",
    attachment: {
      filename: "render.png",
      content_sha256: hash,
      uploaded_sha256: hash,
      byte_count: 4096,
      same_filename_reused: true,
      cache_identity_type: "content_hash",
      fresh_task: true,
      current_revision_confirmed: true,
      visual_canary_passed: true,
      preview_matches_input: true,
    },
    state: {
      task_state_preserved: true,
      external_writes_reconciled: true,
      prior_derived_outputs_invalidated: true,
      replay_requested: false,
      replacement_task_requested: false,
    },
    continuity_route: {
      type: "direct_openai_api",
      verified: true,
      canary_passed: true,
      operation_binding_matches: true,
      artifact_hash_binding_matches: true,
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

runCase("healthy", () => {}, 0, "image_input_revision_verified")
runCase("invalid-hash", (e) => { e.attachment.content_sha256 = "bad" }, 75, "attachment_integrity_receipt_missing_or_invalid")
runCase("hash-mismatch", (e) => { e.attachment.uploaded_sha256 = "b".repeat(64) }, 77, "uploaded_attachment_hash_mismatch")
runCase("filename-cache", (e) => { e.attachment.cache_identity_type = "filename" }, 77, "filename_or_path_keyed_cache_identity_rejected")
runCase("old-outputs-live", (e) => { e.state.prior_derived_outputs_invalidated = false }, 75, "prior_outputs_not_invalidated_after_same_filename_revision")
runCase("no-current-confirmation", (e) => { e.attachment.current_revision_confirmed = false }, 75, "current_image_revision_not_proven_at_visual_runtime_boundary")
runCase("preview-mismatch", (e) => { e.attachment.preview_matches_input = false }, 75, "current_image_revision_not_proven_at_visual_runtime_boundary")
runCase("missing-state", (e) => { e.state.task_state_preserved = false }, 75, "task_or_write_state_not_reconciled")
runCase("unsafe-replay", (e) => { e.state.replay_requested = true; e.state.external_writes_reconciled = false }, 64, "replay_or_replacement_rejected_before_write_reconciliation")
runCase("prohibited-route", (e) => { e.continuity_route.type = "model_gateway" }, 64, "prohibited_route_metadata")

fs.rmSync(tempDir, { recursive: true, force: true })
console.log("codex-image-input-revision-guard: 10 fixtures passed")
