import fs from "node:fs"
import path from "node:path"

const approvedRoutes = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_openai",
  "approved_linux_openai",
])

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function readEvidence(file) {
  const full = path.resolve(file)
  const stat = fs.lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(full, "utf8"))
}

function finish(admitted, reason, action, operationId, code, extra = {}) {
  const text = JSON.stringify({ admitted, reason, action, operation_id: operationId, ...extra }, null, 2)
  ;(admitted ? process.stdout : process.stderr).write(`${text}\n`)
  process.exit(code)
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) finish(false, "missing_input", "provide_evidence_json", "", 2)

let evidence
try {
  evidence = readEvidence(String(args.input))
} catch (error) {
  finish(false, "invalid_evidence", error.message, "", 2)
}

const operationId = String(evidence.operation_id || "").trim()
const mode = String(evidence.mode || "").trim()
const desktop = evidence.desktop || {}
const state = evidence.state || {}
const route = evidence.continuity_route || {}
const archive = evidence.archive || {}

if (!operationId) finish(false, "malformed_evidence", "operation_id_is_required", "", 2)
if (!new Set(["sleep_resume", "archive"]).has(mode)) {
  finish(false, "malformed_evidence", "mode_must_be_sleep_resume_or_archive", operationId, 2)
}
if (String(desktop.platform || "").toLowerCase() !== "windows") {
  finish(false, "unsupported_platform", "this_guard_is_for_windows_codex_desktop_only", operationId, 64)
}

const routeType = String(route.type || "")
const routeReady =
  approvedRoutes.has(routeType) &&
  route.verified === true &&
  route.canary_passed === true &&
  route.operation_binding_matches === true &&
  route.workspace_state_verified === true &&
  route.pinned_openai_model === true &&
  route.automatic_model_selection_disabled === true

if (routeType && !approvedRoutes.has(routeType)) {
  finish(false, "unapproved_continuity_route", "use_only_direct_openai_or_explicitly_authorized_local_routes", operationId, 64)
}
if (state.broad_host_shutdown_requested === true || state.broad_process_shutdown_requested === true) {
  finish(false, "broad_recovery_rejected", "isolate_only_the_affected_desktop_surface_or_exact_owned_process", operationId, 64)
}
if (state.task_state_checkpointed !== true || state.external_writes_reconciled !== true) {
  finish(false, "state_reconciliation_required", "checkpoint_active_tasks_and_reconcile_repository_connector_and_deployment_writes", operationId, 75)
}

if (mode === "sleep_resume") {
  const leakSignal = desktop.wer_pre_leak_detected === true
  const hangSignal = desktop.wer_app_hang_detected === true
  const headlessAfterResume = desktop.resumed_from_sleep === true && desktop.window_present !== true && desktop.process_present === true
  const unresponsive = desktop.responsive === false
  const memoryGrowth = Number(desktop.baseline_working_set_bytes || 0) > 0 && Number(desktop.working_set_bytes || 0) >= Number(desktop.baseline_working_set_bytes || 0) * 2
  const affected = leakSignal || hangSignal || headlessAfterResume || unresponsive || memoryGrowth
  const resumeReady = desktop.corrected_build === true && desktop.signature_valid === true && desktop.cold_start_canary_passed === true && desktop.memory_baseline_canary_passed === true && desktop.sleep_resume_canary_passed === true && desktop.process_termination_canary_passed === true

  if (affected && desktop.sleep_requested === true && Number(desktop.active_task_count || 0) > 0) {
    if (!routeReady) finish(false, "unsafe_sleep_with_active_desktop_work", "bind_unfinished_work_to_a_verified_continuity_route_before_sleep", operationId, 75)
    finish(false, "sleep_deferred_for_desktop_continuity", "close_only_codex_desktop_after_checkpoint_and_continue_the_bound_operation_through_the_verified_route", operationId, 77, { continuity_route: routeType })
  }

  if (affected && !resumeReady) {
    if (!routeReady) finish(false, "windows_desktop_unhealthy_without_verified_continuity_route", "bind_the_unfinished_operation_to_a_verified_direct_or_authorized_local_route", operationId, 75)
    finish(false, "windows_desktop_surface_quarantined", "continue_the_exact_unfinished_operation_through_the_verified_route_without_replay", operationId, 77, {
      continuity_route: routeType,
      leak_signal: leakSignal,
      hang_signal: hangSignal,
      headless_after_resume: headlessAfterResume,
      memory_growth: memoryGrowth,
    })
  }

  if (affected && resumeReady) finish(true, "windows_desktop_resume_canaries_passed", "restore_desktop_authority_for_bounded_canary_workloads", operationId, 0)
  finish(true, "windows_desktop_lifecycle_healthy", "continue_with_normal_task_and_sleep_policy", operationId, 0)
}

const archiveError = String(archive.error_code || "").toUpperCase()
const crossVolumeFailure = archiveError === "ERROR_NOT_SAME_DEVICE" || archiveError === "OS_ERROR_17" || archiveError === "17"
const archiveResumeReady = archive.corrected_build === true && archive.same_volume_canary_passed === true && archive.cross_volume_canary_passed === true && archive.thread_index_canary_passed === true

if (archive.manual_file_move_requested === true || archive.session_database_edit_requested === true) {
  finish(false, "manual_archive_repair_rejected", "do_not_move_session_files_or_edit_codex_state_databases", operationId, 64)
}
if (crossVolumeFailure && archive.blind_retry_requested === true) {
  finish(false, "blind_archive_retry_rejected", "preserve_the_thread_and_stop_repeating_the_same_cross_volume_archive", operationId, 64)
}
if (crossVolumeFailure && !archiveResumeReady) {
  if (!String(archive.thread_id || "").trim() || archive.persisted_state_verified !== true || archive.current_task_access_preserved !== true) {
    finish(false, "archive_failure_requires_thread_state_receipt", "record_thread_identity_and_verify_persisted_state_before_continuing", operationId, 75)
  }
  if (archive.retention_hold_recorded !== true) finish(false, "archive_failure_requires_retention_hold", "suppress_only_the_failed_archive_action_in_the_operator_ledger", operationId, 75)
  if (!routeReady) finish(false, "archive_surface_failed_without_verified_continuity_route", "continue_the_task_through_a_verified_direct_or_authorized_local_route", operationId, 75)
  finish(false, "windows_archive_surface_quarantined", "keep_the_thread_intact_and_continue_work_without_replaying_or_manually_moving_session_state", operationId, 77, {
    continuity_route: routeType,
    thread_id: archive.thread_id,
  })
}
if (crossVolumeFailure && archiveResumeReady) finish(true, "windows_archive_canaries_passed", "restore_archive_authority_for_verified_threads", operationId, 0)
finish(true, "windows_archive_path_healthy", "continue_with_normal_archive_policy", operationId, 0)
