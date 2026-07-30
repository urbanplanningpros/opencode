import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else parsed[key] = true
  }
  return parsed
}

function readJson(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function text(value, name, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return ""
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJson(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
if (prohibited.test(JSON.stringify({ evidence, route: args.route, provider: args.provider, env: process.env.OPERATOR_ROUTE }))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let taskId
let platform
let desktopVersion
let fallbackRoute
try {
  operationId = text(evidence.operation_id, "operation_id")
  taskId = text(evidence.task_id, "task_id")
  platform = text(evidence.platform, "platform").toLowerCase()
  desktopVersion = text(evidence.desktop_version, "desktop_version")
  fallbackRoute = text(evidence.fallback_route, "fallback_route", true).toLowerCase()
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const windows = platform.includes("windows")
const featureUpgradeRequested = bool(evidence.feature_upgrade_requested, "feature_upgrade_requested")
const sandboxOfflinePresent = bool(evidence.codex_sandbox_offline_present, "codex_sandbox_offline_present")
const sandboxOnlinePresent = bool(evidence.codex_sandbox_online_present, "codex_sandbox_online_present")
const profileListRegistrationPresent = bool(evidence.profile_list_registration_present, "profile_list_registration_present")
const profileDirectoryPresent = bool(evidence.profile_directory_present, "profile_directory_present")
const migrationFailureObserved = bool(evidence.migration_failure_observed, "migration_failure_observed")
const expectedErrorSignatureObserved = bool(evidence.expected_error_signature_observed, "expected_error_signature_observed")
const setupLogsPreserved = bool(evidence.setup_logs_preserved, "setup_logs_preserved")
const taskStateCheckpointed = bool(evidence.task_state_checkpointed, "task_state_checkpointed")
const repositoryWritesReconciled = bool(evidence.repository_writes_reconciled, "repository_writes_reconciled")
const externalWritesReconciled = bool(evidence.external_writes_reconciled, "external_writes_reconciled")
const automaticUpgradeRetrySuppressed = bool(evidence.automatic_upgrade_retry_suppressed, "automatic_upgrade_retry_suppressed")
const manualRegistryDeletionRequested = bool(evidence.manual_registry_deletion_requested, "manual_registry_deletion_requested")
const manualProfileDeletionRequested = bool(evidence.manual_profile_deletion_requested, "manual_profile_deletion_requested")
const supportedTeardownReceipt = bool(evidence.supported_teardown_receipt, "supported_teardown_receipt")
const systemBackupVerified = bool(evidence.system_backup_verified, "system_backup_verified")
const disposableUpgradeCanaryPassed = bool(evidence.disposable_upgrade_canary_passed, "disposable_upgrade_canary_passed")
const postUpgradeSandboxRecreated = bool(evidence.post_upgrade_sandbox_recreated, "post_upgrade_sandbox_recreated")
const postUpgradeCodexCanaryPassed = bool(evidence.post_upgrade_codex_canary_passed, "post_upgrade_codex_canary_passed")

const sandboxProfileBoundaryPresent =
  sandboxOfflinePresent || sandboxOnlinePresent || profileListRegistrationPresent || profileDirectoryPresent

const approvedFallbackRoutes = new Set([
  "none",
  "direct_openai_linux",
  "approved_local_linux",
  "approved_remote_linux",
  "decommission_and_reimage_windows",
])

let admitted = true
let reason = "windows_feature_upgrade_boundary_clear"
let exitCode = 0

if (!windows) {
  reason = "not_windows_host"
} else if (!approvedFallbackRoutes.has(fallbackRoute || "none")) {
  admitted = false
  reason = "unapproved_continuity_route"
  exitCode = 64
} else if (manualRegistryDeletionRequested || manualProfileDeletionRequested) {
  admitted = false
  reason = "unverified_manual_sandbox_profile_deletion_forbidden"
  exitCode = 64
} else if (!featureUpgradeRequested) {
  reason = sandboxProfileBoundaryPresent ? "sandbox_profiles_present_no_feature_upgrade_requested" : "no_feature_upgrade_requested"
} else if (!sandboxProfileBoundaryPresent) {
  reason = "feature_upgrade_preflight_clear"
} else if (!taskStateCheckpointed || !repositoryWritesReconciled || !externalWritesReconciled) {
  admitted = false
  reason = "operator_state_reconciliation_required_before_host_service"
  exitCode = 75
} else if (migrationFailureObserved && (!setupLogsPreserved || !expectedErrorSignatureObserved)) {
  admitted = false
  reason = "migration_failure_evidence_incomplete"
  exitCode = 75
} else if (migrationFailureObserved && !automaticUpgradeRetrySuppressed) {
  admitted = false
  reason = "automatic_feature_upgrade_retry_must_be_suppressed"
  exitCode = 75
} else if (!supportedTeardownReceipt) {
  if (!fallbackRoute || fallbackRoute === "none") {
    admitted = false
    reason = "supported_sandbox_teardown_or_continuity_route_required"
    exitCode = 75
  } else {
    reason = "windows_feature_upgrade_isolated_operator_work_rerouted"
  }
} else if (!systemBackupVerified || !disposableUpgradeCanaryPassed) {
  admitted = false
  reason = "backup_and_disposable_upgrade_canary_required"
  exitCode = 75
} else if (!postUpgradeSandboxRecreated || !postUpgradeCodexCanaryPassed) {
  admitted = false
  reason = "post_upgrade_sandbox_recreation_and_codex_canary_required"
  exitCode = 75
} else {
  reason = "windows_feature_upgrade_and_codex_sandbox_recovery_verified"
}

const report = {
  admitted,
  reason,
  operation_id: operationId,
  task_id: taskId,
  platform,
  desktop_version: desktopVersion,
  feature_upgrade_requested: featureUpgradeRequested,
  sandbox_profile_boundary_present: sandboxProfileBoundaryPresent,
  migration_failure_observed: migrationFailureObserved,
  expected_error_signature_observed: expectedErrorSignatureObserved,
  setup_logs_preserved: setupLogsPreserved,
  task_state_checkpointed: taskStateCheckpointed,
  repository_writes_reconciled: repositoryWritesReconciled,
  external_writes_reconciled: externalWritesReconciled,
  automatic_upgrade_retry_suppressed: automaticUpgradeRetrySuppressed,
  supported_teardown_receipt: supportedTeardownReceipt,
  disposable_upgrade_canary_passed: disposableUpgradeCanaryPassed,
  post_upgrade_sandbox_recreated: postUpgradeSandboxRecreated,
  post_upgrade_codex_canary_passed: postUpgradeCodexCanaryPassed,
  fallback_route: fallbackRoute || "none",
  protocol: admitted
    ? "Keep business-critical work running through direct OpenAI or an explicitly approved Linux route. Treat Codex sandbox helper profiles as a Windows feature-upgrade preflight boundary. Use only a supported teardown/recreation path, verified backup, disposable upgrade canary, and post-upgrade Codex canary before restoring this host to mutation authority."
    : "Do not blindly retry Windows Setup or manually delete Codex sandbox registry/profile state. Preserve setup logs, checkpoint task state, reconcile repository and external writes, suppress automatic upgrade retries, and reroute the exact unfinished operator work through direct OpenAI or an explicitly approved Linux route. Isolate only the affected Windows feature upgrade until a supported teardown/recreation path and canaries are verified.",
  resume_condition:
    "Resume Windows feature-upgrade authority after the Codex sandbox profiles are removed through a supported, receipt-producing method; a system backup and disposable in-place-upgrade canary pass; the target host upgrades successfully; Codex recreates its sandbox cleanly; and repository, connector, and command canaries pass without duplicate writes.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
