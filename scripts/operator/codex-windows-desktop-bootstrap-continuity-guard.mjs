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
    if (next && !next.startsWith("--")) { out[key] = next; i += 1 } else out[key] = true
  }
  return out
}

function readEvidence(file) {
  const full = path.resolve(file)
  const stat = fs.lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(full, "utf8"))
}

function output(admitted, reason, action, operationId, code, extra = {}) {
  const text = JSON.stringify({ admitted, reason, action, operation_id: operationId, ...extra }, null, 2)
  ;(admitted ? process.stdout : process.stderr).write(`${text}\n`)
  process.exit(code)
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) output(false, "missing_input", "provide_evidence_json", "", 2)
let e
try { e = readEvidence(String(args.input)) } catch (error) { output(false, "invalid_evidence", error.message, "", 2) }

const operationId = String(e.operation_id || "").trim()
const app = e.desktop || {}
const state = e.state || {}
const route = e.continuity_route || {}
if (!operationId) output(false, "malformed_evidence", "operation_id_is_required", "", 2)

const nativeFailure = String(app.platform || "").toLowerCase() === "windows" && app.launch_attempted === true && (app.chromium_initialized !== true || String(app.exit_code || "").toUpperCase() === "0XC0000001")
const sandboxFailure = app.sandbox_setup_launched === true && app.sandbox_setup_succeeded !== true
const routeReady = approvedRoutes.has(String(route.type || "")) && route.verified === true && route.canary_passed === true && route.operation_binding_matches === true && route.workspace_head_verified === true
const resumeReady = app.corrected_build === true && app.signature_valid === true && app.cold_start_canary_passed === true && app.sandbox_canary_passed === true && app.multi_task_restart_canary_passed === true

if (state.broad_host_shutdown_requested === true) output(false, "broad_host_shutdown_rejected", "isolate_only_the_windows_desktop_surface_and_keep_verified_cli_api_or_local_work_running", operationId, 64)
if (state.app_state_deletion_requested === true && (state.task_state_preserved !== true || state.external_writes_reconciled !== true)) output(false, "destructive_app_state_recovery_rejected_before_reconciliation", "preserve_state_and_reconcile_all_work_before_targeted_repair", operationId, 64)
if ((nativeFailure || sandboxFailure) && state.reinstall_requested === true && Number(app.reinstall_count || 0) >= 1 && app.corrected_build !== true) output(false, "blind_reinstall_loop_rejected", "preserve_diagnostics_and_stop_reinstalling_the_same_build", operationId, 77)
if ((nativeFailure || sandboxFailure) && (state.task_state_preserved !== true || state.external_writes_reconciled !== true)) output(false, "desktop_failure_requires_state_and_write_reconciliation", "checkpoint_active_tasks_and_reconcile_repository_connector_and_deployment_writes", operationId, 75)
if ((nativeFailure || sandboxFailure) && !routeReady) output(false, "desktop_unavailable_without_verified_continuity_route", "bind_the_unfinished_operation_to_a_verified_direct_or_authorized_local_route", operationId, 75)
if ((nativeFailure || sandboxFailure) && routeReady) output(false, "windows_desktop_surface_quarantined", "continue_the_unfinished_work_through_the_verified_route_without_replaying_completed_mutations", operationId, 77)
if (!resumeReady) output(false, "desktop_resume_canaries_incomplete", "withhold_only_desktop_authority_until_a_corrected_signed_build_passes_cold_start_sandbox_and_restart_canaries", operationId, 75)

output(true, "windows_desktop_bootstrap_verified", "continue_on_verified_desktop_surface", operationId, 0, { native_bootstrap_failure: nativeFailure, sandbox_bootstrap_failure: sandboxFailure, continuity_route_ready: routeReady, desktop_resume_ready: resumeReady })
