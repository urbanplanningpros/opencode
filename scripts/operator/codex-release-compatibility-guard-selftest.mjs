import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-compatibility-"))
const guard = path.join(process.cwd(), "scripts/operator/codex-release-compatibility-guard.mjs")
const hash = "a".repeat(64)

function run(name, evidence, expectedStatus, expectedResult) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedStatus) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${name}: expected exit ${expectedStatus}, received ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedResult) throw new Error(`${name}: expected ${expectedResult}, received ${output.status}`)
  return output
}

const base = {
  app_server_version: "0.146.0",
  exec_server_version: "0.145.0",
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  mcp: {
    transport: "http",
    configured_server_name: "approved-crm",
    discovered_server_name: "approved-crm",
    approved_tool_catalog_sha256: hash,
    observed_tool_catalog_sha256: hash,
    write_authority_requested: true,
    oauth: { status: "ok", retry_count: 0 },
  },
}

try {
  run("healthy", base, 0, "compatible")

  const legacy = structuredClone(base)
  legacy.exec_server_version = "0.144.4"
  const legacyResult = run("legacy", legacy, 75, "remediation_required")
  if (!legacyResult.remediation.some((item) => item.includes("exec_server_version_below"))) {
    throw new Error("legacy: missing version-floor remediation")
  }

  const missingIdentity = structuredClone(base)
  missingIdentity.mcp.discovered_server_name = null
  const missingResult = run("missing-identity", missingIdentity, 0, "compatible")
  if (!missingResult.warnings.includes("mcp_server_identity_missing_using_configured_name")) {
    throw new Error("missing-identity: warning was not emitted")
  }

  const drift = structuredClone(base)
  drift.mcp.observed_tool_catalog_sha256 = "b".repeat(64)
  const driftResult = run("catalog-drift", drift, 64, "blocked")
  if (!driftResult.blocked.includes("mcp_tool_catalog_drift")) throw new Error("catalog-drift: drift was not blocked")

  const transient = structuredClone(base)
  transient.mcp.oauth = { status: "transient_http", retry_count: 0 }
  run("transient", transient, 75, "remediation_required")

  const anonymous = structuredClone(transient)
  anonymous.mcp.oauth.anonymous_fallback_requested = true
  const anonymousResult = run("anonymous", anonymous, 64, "blocked")
  if (!anonymousResult.blocked.includes("oauth_anonymous_fallback_requested")) {
    throw new Error("anonymous: unsafe fallback was not blocked")
  }

  const stagedUpload = structuredClone(base)
  stagedUpload.mcp.file_upload = {
    host_environment_id: "windows-control",
    selected_turn_environment_id: "linux-vps",
    path_resolution_environment_id: "linux-vps",
    resolved_in_selected_environment: true,
    file_exists_in_selected_environment: true,
    staged_in_selected_environment: true,
    environment_native_fix_present: false,
    host_native_rewrite_used: false,
    approved_file_sha256: hash,
    observed_file_sha256: hash,
    previous_attempt_status: "not_started",
  }
  const stagedResult = run("staged-cross-environment-upload", stagedUpload, 0, "compatible")
  if (!stagedResult.warnings.includes("mcp_environment_native_upload_fix_not_in_pinned_stable")) {
    throw new Error("staged-cross-environment-upload: missing stable-fix warning")
  }

  const wrongEnvironmentUpload = structuredClone(stagedUpload)
  wrongEnvironmentUpload.mcp.file_upload.path_resolution_environment_id = "windows-control"
  wrongEnvironmentUpload.mcp.file_upload.host_native_rewrite_used = true
  const wrongEnvironmentResult = run("wrong-environment-upload", wrongEnvironmentUpload, 64, "blocked")
  if (!wrongEnvironmentResult.blocked.includes("mcp_upload_resolved_against_wrong_environment")) {
    throw new Error("wrong-environment-upload: incorrect path environment was not blocked")
  }

  const uncertainUpload = structuredClone(stagedUpload)
  uncertainUpload.mcp.file_upload.previous_attempt_status = "failed_after_dispatch"
  uncertainUpload.mcp.file_upload.durable_side_effect_reconciled = false
  const uncertainUploadResult = run("uncertain-upload", uncertainUpload, 64, "blocked")
  if (!uncertainUploadResult.blocked.includes("mcp_upload_uncertain_side_effect_not_reconciled")) {
    throw new Error("uncertain-upload: unreconciled upload was not blocked")
  }

  const artifactAffected = structuredClone(base)
  artifactAffected.artifact_runtime = {
    platform: "darwin",
    launcher: "desktop-cua-node",
    selected_executor: "desktop-cua-node",
    hardened_runtime: true,
    native_addon_signed: false,
    library_validation_disabled: false,
    manifest_package_version: "2.8.31",
    installed_package_version: "2.8.33",
  }
  const artifactAffectedResult = run("artifact-affected", artifactAffected, 75, "remediation_required")
  if (!artifactAffectedResult.remediation.includes("reroute_artifact_execution_to_primary_runtime_node_or_approved_local")) {
    throw new Error("artifact-affected: missing primary-runtime reroute")
  }

  const artifactRerouted = structuredClone(artifactAffected)
  artifactRerouted.artifact_runtime.selected_executor = "primary-runtime-node"
  artifactRerouted.artifact_runtime.import_canary_passed = true
  run("artifact-rerouted", artifactRerouted, 0, "compatible")

  const artifactUnsafe = structuredClone(artifactRerouted)
  artifactUnsafe.artifact_runtime.local_resign_requested = true
  const artifactUnsafeResult = run("artifact-local-resign", artifactUnsafe, 64, "blocked")
  if (!artifactUnsafeResult.blocked.includes("artifact_native_module_resign_requested")) {
    throw new Error("artifact-local-resign: unsafe signature modification was not blocked")
  }

  const tuiPreflight = structuredClone(base)
  tuiPreflight.tui_continuity = {
    platform: "darwin",
    codex_version: "0.146.0",
    shared_app_server: true,
    unattended_long_task: true,
    session_id: "session-123",
    checkpoint_sha256: hash,
    supervisor_checkpointing_enabled: false,
  }
  const tuiPreflightResult = run("tui-preflight", tuiPreflight, 75, "remediation_required")
  if (!tuiPreflightResult.remediation.includes("enable_same_session_tui_supervisor_checkpointing")) {
    throw new Error("tui-preflight: missing supervisor remediation")
  }

  const tuiRecovery = structuredClone(tuiPreflight)
  tuiRecovery.tui_continuity.supervisor_checkpointing_enabled = true
  tuiRecovery.tui_continuity.unexpected_exit_observed = true
  tuiRecovery.tui_continuity.canonical_state = "interrupted"
  tuiRecovery.tui_continuity.uncertain_writes_reconciled = true
  tuiRecovery.tui_continuity.same_session_resume_requested = true
  tuiRecovery.tui_continuity.resume_attempt_count = 0
  const tuiRecoveryResult = run("tui-same-session-recovery", tuiRecovery, 75, "remediation_required")
  if (!tuiRecoveryResult.remediation.includes("resume_same_session_once_with_codex_resume")) {
    throw new Error("tui-same-session-recovery: missing bounded same-session recovery")
  }

  const tuiReplay = structuredClone(tuiRecovery)
  tuiReplay.tui_continuity.canonical_state = "completed"
  tuiReplay.tui_continuity.replay_requested = true
  const tuiReplayResult = run("tui-completed-replay", tuiReplay, 64, "blocked")
  if (!tuiReplayResult.blocked.includes("tui_completed_session_resume_or_replay_rejected")) {
    throw new Error("tui-completed-replay: completed task replay was not blocked")
  }

  const prohibited = structuredClone(base)
  prohibited.routing = { provider: "anthropic", route: "gateway", automatic_selector: true }
  run("prohibited", prohibited, 64, "blocked")

  console.log("Codex release compatibility guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
