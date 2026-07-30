import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-saved-task-payload-continuity-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-saved-task-payload-"))
const hash = "a".repeat(64)

const base = {
  task_id: "task-payload-1",
  operation_id: "op-payload-1",
  idempotency_key: "idem-payload-1",
  payload: {
    serialized_bytes: 10_000,
    duplicated_inline_image_bytes: 0,
    inline_image_count: 0,
    contains_base64_images: false,
    task_reopen_requested: false,
  },
  crash: {
    renderer_crashed: false,
    signature: "",
    reproduced_build_count: 0,
  },
  recovery: {},
}

function run(name, patch, expectedCode, expectedReason) {
  const evidence = structuredClone(base)
  Object.assign(evidence, patch)
  const file = path.join(temp, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedCode, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason, name)
}

run("healthy", {}, 0, "saved_task_payload_continuity_verified")

const affectedPayload = {
  serialized_bytes: 700 * 1024 * 1024,
  duplicated_inline_image_bytes: 680 * 1024 * 1024,
  inline_image_count: 240,
  contains_base64_images: true,
  task_reopen_requested: true,
}
const affectedCrash = {
  renderer_crashed: true,
  signature: "EXC_BREAKPOINT SIGTRAP V8 ValueSerializer::HasCustomHostObject",
  reproduced_build_count: 2,
}

run("affected-not-recovered", {
  payload: affectedPayload,
  crash: affectedCrash,
  recovery: { original_task_preserved: true },
}, 75, "oversized_saved_task_state_unreconciled")

run("fresh-task-checkpoint", {
  payload: affectedPayload,
  crash: affectedCrash,
  recovery: {
    continuation_route: "fresh_task_compact_checkpoint",
    original_task_preserved: true,
    removed_from_auto_resume: true,
    workspace_files_verified: true,
    external_writes_reconciled: true,
    compact_checkpoint_created: true,
    checkpoint_sha256: hash,
    inline_images_externalized: true,
    artifact_manifest_verified: true,
  },
}, 0, "fresh_task_checkpoint_recovery_verified")

run("workspace-direct", {
  payload: affectedPayload,
  crash: affectedCrash,
  recovery: {
    continuation_route: "workspace_files_direct",
    original_task_preserved: true,
    removed_from_auto_resume: true,
    workspace_files_verified: true,
    external_writes_reconciled: true,
  },
}, 0, "workspace_direct_recovery_verified")

run("approved-local", {
  payload: affectedPayload,
  crash: affectedCrash,
  recovery: {
    continuation_route: "approved_local",
    original_task_preserved: true,
    removed_from_auto_resume: true,
    workspace_files_verified: true,
    external_writes_reconciled: true,
    approved_executor_verified: true,
  },
}, 0, "approved_executor_saved_task_recovery_verified")

run("automatic-reopen-rejected", {
  payload: affectedPayload,
  crash: affectedCrash,
  recovery: { automatic_reopen_attempted: true },
}, 64, "unsafe_saved_task_reopen_replay_or_cleanup_forbidden")

run("destructive-cleanup-rejected", {
  payload: affectedPayload,
  crash: affectedCrash,
  recovery: { destructive_cleanup_attempted: true },
}, 64, "unsafe_saved_task_reopen_replay_or_cleanup_forbidden")

run("prohibited-route", {
  recovery: { continuation_route: "gateway-auto-select" },
}, 64, "prohibited_route_metadata")

fs.rmSync(temp, { recursive: true, force: true })
console.log("codex saved task payload continuity guard self-test passed")
