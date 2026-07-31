import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const guard = fileURLToPath(new URL("./codex-windows-desktop-lifecycle-continuity-guard.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-lifecycle-"))

const baseRoute = {
  type: "direct_openai_cli",
  verified: true,
  canary_passed: true,
  operation_binding_matches: true,
  workspace_state_verified: true,
  pinned_openai_model: true,
  automatic_model_selection_disabled: true,
}

const base = {
  operation_id: "op-test",
  desktop: { platform: "windows", responsive: true, window_present: true },
  state: { task_state_checkpointed: true, external_writes_reconciled: true },
  continuity_route: baseRoute,
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  assert.equal(result.status, expectedCode, `${name}: ${result.stderr || result.stdout}`)
  const parsed = JSON.parse((result.stdout || result.stderr).trim())
  assert.equal(parsed.reason, expectedReason, name)
}

run("healthy-sleep", { ...base, mode: "sleep_resume" }, 0, "windows_desktop_lifecycle_healthy")
run("missing-checkpoint", { ...base, mode: "sleep_resume", state: { task_state_checkpointed: false, external_writes_reconciled: true } }, 75, "state_reconciliation_required")
run("broad-shutdown", { ...base, mode: "sleep_resume", state: { ...base.state, broad_process_shutdown_requested: true } }, 64, "broad_recovery_rejected")
run("sleep-route-missing", { ...base, mode: "sleep_resume", desktop: { ...base.desktop, wer_pre_leak_detected: true, sleep_requested: true, active_task_count: 2 }, continuity_route: {} }, 75, "unsafe_sleep_with_active_desktop_work")
run("sleep-deferred", { ...base, mode: "sleep_resume", desktop: { ...base.desktop, wer_pre_leak_detected: true, sleep_requested: true, active_task_count: 2 } }, 77, "sleep_deferred_for_desktop_continuity")
run("headless-quarantine", { ...base, mode: "sleep_resume", desktop: { ...base.desktop, resumed_from_sleep: true, process_present: true, window_present: false } }, 77, "windows_desktop_surface_quarantined")
run("resume-canaries", { ...base, mode: "sleep_resume", desktop: { ...base.desktop, wer_app_hang_detected: true, corrected_build: true, signature_valid: true, cold_start_canary_passed: true, memory_baseline_canary_passed: true, sleep_resume_canary_passed: true, process_termination_canary_passed: true } }, 0, "windows_desktop_resume_canaries_passed")
run("archive-manual-move", { ...base, mode: "archive", archive: { error_code: "ERROR_NOT_SAME_DEVICE", manual_file_move_requested: true } }, 64, "manual_archive_repair_rejected")
run("archive-blind-retry", { ...base, mode: "archive", archive: { error_code: "OS_ERROR_17", blind_retry_requested: true } }, 64, "blind_archive_retry_rejected")
run("archive-receipt-missing", { ...base, mode: "archive", archive: { error_code: "17" } }, 75, "archive_failure_requires_thread_state_receipt")
run("archive-hold-missing", { ...base, mode: "archive", archive: { error_code: "17", thread_id: "thread-1", persisted_state_verified: true, current_task_access_preserved: true } }, 75, "archive_failure_requires_retention_hold")
run("archive-quarantine", { ...base, mode: "archive", archive: { error_code: "17", thread_id: "thread-1", persisted_state_verified: true, current_task_access_preserved: true, retention_hold_recorded: true } }, 77, "windows_archive_surface_quarantined")
run("archive-resume-canaries", { ...base, mode: "archive", archive: { error_code: "17", corrected_build: true, same_volume_canary_passed: true, cross_volume_canary_passed: true, thread_index_canary_passed: true } }, 0, "windows_archive_canaries_passed")
run("unapproved-route", { ...base, mode: "sleep_resume", continuity_route: { ...baseRoute, type: "automatic_gateway" } }, 64, "unapproved_continuity_route")

fs.rmSync(root, { recursive: true, force: true })
console.log("14 deterministic fixtures passed")
