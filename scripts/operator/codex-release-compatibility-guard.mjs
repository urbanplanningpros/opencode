import fs from "node:fs"
import { nowIso, parseArgs, sha256 } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const input = args.input
if (!input) {
  console.error("Usage: bun scripts/operator/codex-release-compatibility-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

const minimum = "0.145.0"
const prohibited = [
  "anthropic",
  "claude",
  "manus",
  "openrouter",
  "litellm",
  "bedrock",
  "vertex",
  "copilot-auto",
  "model-gateway",
]

function version(value) {
  const match = String(value || "").trim().match(/^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return match.slice(1).map(Number)
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] === right[index]) continue
    return left[index] > right[index] ? 1 : -1
  }
  return 0
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(text(value).toLowerCase())
}

let evidence
try {
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read compatibility evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []
const floor = version(minimum)
const versions = {
  app_server: text(evidence.app_server_version),
  exec_server: text(evidence.exec_server_version),
}

for (const [role, raw] of Object.entries(versions)) {
  const parsed = version(raw)
  if (!parsed) {
    blocked.push(`${role}_version_invalid`)
    continue
  }
  if (compare(parsed, floor) < 0) remediation.push(`${role}_version_below_${minimum}`)
}

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const routeReceipt = `${provider} ${route}`
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.some((name) => routeReceipt.includes(name))) blocked.push("prohibited_provider_or_gateway")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const mcp = evidence.mcp || null
if (mcp) {
  const transport = text(mcp.transport).toLowerCase()
  const configured = text(mcp.configured_server_name)
  const discovered = text(mcp.discovered_server_name)
  const approvedHash = text(mcp.approved_tool_catalog_sha256).toLowerCase()
  const observedHash = text(mcp.observed_tool_catalog_sha256).toLowerCase()
  const writeAuthority = mcp.write_authority_requested === true

  if (!["stdio", "http", "sse"].includes(transport)) blocked.push("mcp_transport_invalid")
  if (!configured) blocked.push("mcp_configured_server_name_missing")
  if (!discovered) warnings.push("mcp_server_identity_missing_using_configured_name")
  if (approvedHash && !isSha256(approvedHash)) blocked.push("approved_tool_catalog_hash_invalid")
  if (observedHash && !isSha256(observedHash)) blocked.push("observed_tool_catalog_hash_invalid")
  if (writeAuthority && (!approvedHash || !observedHash)) blocked.push("tool_catalog_hash_required_for_write_authority")
  if (approvedHash && observedHash && approvedHash !== observedHash) blocked.push("mcp_tool_catalog_drift")

  const oauth = mcp.oauth || {}
  const oauthStatus = text(oauth.status || "ok").toLowerCase()
  const retries = Number(oauth.retry_count || 0)
  const crossOrigin = oauth.cross_origin_redirect === true

  if (!Number.isInteger(retries) || retries < 0) blocked.push("oauth_retry_count_invalid")
  if (oauth.anonymous_fallback_requested === true) blocked.push("oauth_anonymous_fallback_requested")
  if (oauth.credential_reset_requested === true) blocked.push("oauth_credential_reset_requested")
  if (oauthStatus === "transport_error" || oauthStatus === "transient_http") {
    if (retries > 1) blocked.push("oauth_retry_budget_exceeded")
    else remediation.push("retry_same_endpoint_once_after_state_reconciliation")
  } else if (oauthStatus === "redirect") {
    if (crossOrigin) blocked.push("oauth_cross_origin_redirect")
    else remediation.push("review_same_origin_redirect_before_retry")
  } else if (oauthStatus === "unauthorized") {
    remediation.push("reauthenticate_exact_approved_connector")
  } else if (oauthStatus !== "ok") {
    blocked.push("oauth_status_unknown")
  }

  const upload = mcp.file_upload || null
  if (upload) {
    const hostEnvironment = text(upload.host_environment_id)
    const selectedEnvironment = text(upload.selected_turn_environment_id)
    const resolutionEnvironment = text(upload.path_resolution_environment_id)
    const crossEnvironment = hostEnvironment && selectedEnvironment && hostEnvironment !== selectedEnvironment
    const approvedFileHash = text(upload.approved_file_sha256).toLowerCase()
    const observedFileHash = text(upload.observed_file_sha256).toLowerCase()
    const attemptStatus = text(upload.previous_attempt_status || "not_started").toLowerCase()

    if (!selectedEnvironment) blocked.push("mcp_upload_selected_turn_environment_missing")
    if (!resolutionEnvironment) blocked.push("mcp_upload_path_resolution_environment_missing")
    if (selectedEnvironment && resolutionEnvironment && selectedEnvironment !== resolutionEnvironment) {
      blocked.push("mcp_upload_resolved_against_wrong_environment")
    }
    if (crossEnvironment && upload.host_native_rewrite_used === true) {
      blocked.push("mcp_upload_host_native_path_rewrite_crossed_environment")
    }
    if (upload.resolved_in_selected_environment !== true) {
      remediation.push("resolve_upload_path_inside_selected_turn_environment")
    }
    if (upload.file_exists_in_selected_environment !== true) {
      remediation.push("stage_upload_file_in_selected_turn_environment")
    }
    if (crossEnvironment && upload.environment_native_fix_present !== true && upload.staged_in_selected_environment !== true) {
      remediation.push("stage_file_before_cross_environment_mcp_upload")
    }
    if (writeAuthority && (!approvedFileHash || !observedFileHash)) {
      blocked.push("mcp_upload_file_hashes_required_for_write_authority")
    }
    if (approvedFileHash && !isSha256(approvedFileHash)) blocked.push("mcp_upload_approved_file_hash_invalid")
    if (observedFileHash && !isSha256(observedFileHash)) blocked.push("mcp_upload_observed_file_hash_invalid")
    if (approvedFileHash && observedFileHash && approvedFileHash !== observedFileHash) {
      blocked.push("mcp_upload_file_hash_mismatch")
    }
    if (["unknown", "failed_after_dispatch"].includes(attemptStatus) && upload.durable_side_effect_reconciled !== true) {
      blocked.push("mcp_upload_uncertain_side_effect_not_reconciled")
    }
    if (upload.environment_native_fix_present !== true) {
      warnings.push("mcp_environment_native_upload_fix_not_in_pinned_stable")
    }
  }
}

const artifactRuntime = evidence.artifact_runtime || null
if (artifactRuntime) {
  const platform = text(artifactRuntime.platform).toLowerCase()
  const launcher = text(artifactRuntime.launcher).toLowerCase()
  const selectedExecutor = text(artifactRuntime.selected_executor).toLowerCase()
  const affected =
    platform === "darwin" &&
    launcher === "desktop-cua-node" &&
    artifactRuntime.hardened_runtime === true &&
    artifactRuntime.native_addon_signed === false &&
    artifactRuntime.library_validation_disabled !== true

  if (artifactRuntime.local_resign_requested === true) blocked.push("artifact_native_module_resign_requested")
  if (artifactRuntime.disable_library_validation_requested === true) blocked.push("artifact_library_validation_weakening_requested")
  if (text(artifactRuntime.manifest_package_version) && text(artifactRuntime.installed_package_version) && text(artifactRuntime.manifest_package_version) !== text(artifactRuntime.installed_package_version)) {
    warnings.push("artifact_runtime_package_metadata_mismatch")
  }

  if (affected) {
    if (!["primary-runtime-node", "approved-local"].includes(selectedExecutor)) {
      remediation.push("reroute_artifact_execution_to_primary_runtime_node_or_approved_local")
    } else if (artifactRuntime.import_canary_passed !== true) {
      remediation.push("run_artifact_import_canary_before_authority")
    } else {
      warnings.push("desktop_cua_node_artifact_path_isolated")
    }
  }
}

const tui = evidence.tui_continuity || null
if (tui) {
  const platform = text(tui.platform).toLowerCase()
  const codexVersion = text(tui.codex_version)
  const affected = platform === "darwin" && codexVersion === "0.146.0" && tui.shared_app_server === true
  const sessionId = text(tui.session_id)
  const checkpointHash = text(tui.checkpoint_sha256).toLowerCase()
  const canonicalState = text(tui.canonical_state || "unknown").toLowerCase()
  const resumeAttempts = Number(tui.resume_attempt_count || 0)

  if (affected && tui.unattended_long_task === true) {
    warnings.push("macos_tui_0_146_unattended_exit_risk")
    if (!sessionId || !isSha256(checkpointHash)) {
      remediation.push("persist_session_id_and_external_checkpoint_before_unattended_work")
    }
    if (tui.supervisor_checkpointing_enabled !== true) {
      remediation.push("enable_same_session_tui_supervisor_checkpointing")
    }
  }

  if (tui.unexpected_exit_observed === true) {
    if (tui.replacement_session_requested === true) blocked.push("tui_replacement_session_recovery_rejected")
    if (!Number.isInteger(resumeAttempts) || resumeAttempts < 0) blocked.push("tui_resume_attempt_count_invalid")
    if (resumeAttempts > 1) blocked.push("tui_same_session_resume_budget_exceeded")
    if (canonicalState === "unknown") blocked.push("tui_canonical_state_unknown")

    if (canonicalState === "completed") {
      if (tui.same_session_resume_requested === true || tui.replay_requested === true) {
        blocked.push("tui_completed_session_resume_or_replay_rejected")
      }
    } else if (["active", "failed", "interrupted"].includes(canonicalState)) {
      if (tui.uncertain_writes_reconciled !== true) blocked.push("tui_uncertain_writes_not_reconciled")
      if (tui.same_session_resume_requested !== true) remediation.push("resume_existing_tui_session_once")
      else remediation.push("resume_same_session_once_with_codex_resume")
    } else if (canonicalState !== "unknown") {
      blocked.push("tui_canonical_state_invalid")
    }
  }
}

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: nowIso(),
  status,
  minimum_supported_codex_version: minimum,
  versions,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  continuity_route: status === "compatible" ? "current approved route" : "approved OpenAI stable route or explicitly authorized local executor",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex release compatibility: ${status}`)
  console.log(`Version floor: ${minimum}; app-server ${versions.app_server}; exec-server ${versions.exec_server}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
  if (result.warnings.length > 0) console.error(`Warnings: ${result.warnings.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
