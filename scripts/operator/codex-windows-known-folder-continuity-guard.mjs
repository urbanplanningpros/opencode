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
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJson(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("evidence must be a regular non-symlink file")
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function text(value, name, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return ""
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function normalizeWindowsPath(value) {
  if (!value) return ""
  const normalized = path.win32.normalize(value).replace(/[\\/]+$/u, "")
  return normalized.toLowerCase()
}

function isWithinWindowsPath(candidate, root) {
  const normalizedCandidate = normalizeWindowsPath(candidate)
  const normalizedRoot = normalizeWindowsPath(root)
  if (!normalizedCandidate || !normalizedRoot) return false
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
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
if (prohibited.test(JSON.stringify({ evidence, provider: args.provider, route: args.route, env: process.env.OPERATOR_ROUTE }))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let taskId
let operationId
let platform
let desktopBuild
let knownDocumentsPath
let observedWorkspacePath
let sandboxPermissionRoot
let rerouteTarget
try {
  taskId = text(evidence.task_id, "task_id")
  operationId = text(evidence.operation_id, "operation_id")
  platform = text(evidence.platform, "platform").toLowerCase()
  desktopBuild = text(evidence.desktop_build, "desktop_build", true)
  knownDocumentsPath = text(evidence.windows_known_documents_path, "windows_known_documents_path", true)
  observedWorkspacePath = text(evidence.observed_workspace_path, "observed_workspace_path", true)
  sandboxPermissionRoot = text(evidence.sandbox_permission_root, "sandbox_permission_root", true)
  rerouteTarget = text(evidence.reroute_target, "reroute_target", true).toLowerCase()
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const windows = platform.includes("windows")
const projectlessTask = bool(evidence.projectless_task, "projectless_task")
const junctionPresent = bool(evidence.legacy_documents_junction_present, "legacy_documents_junction_present")
const junctionModifiedOrRemoved = bool(
  evidence.legacy_documents_junction_modified_or_removed,
  "legacy_documents_junction_modified_or_removed",
)
const workspaceWriteIsolated = bool(evidence.workspace_write_isolated, "workspace_write_isolated")
const workspaceCheckpointPreserved = bool(
  evidence.workspace_checkpoint_preserved,
  "workspace_checkpoint_preserved",
)
const uncertainWritesReconciled = bool(evidence.uncertain_writes_reconciled, "uncertain_writes_reconciled")
const canonicalWorkspaceCanaryPassed = bool(
  evidence.canonical_workspace_canary_passed,
  "canonical_workspace_canary_passed",
)
const workspaceIdentityVerified = bool(evidence.workspace_identity_verified, "workspace_identity_verified")
const sandboxPermissionRootVerified = bool(
  evidence.sandbox_permission_root_verified,
  "sandbox_permission_root_verified",
)

const expectedProjectlessRoot = knownDocumentsPath ? path.win32.join(knownDocumentsPath, "Codex") : ""
const workspaceUnderKnownFolder =
  !projectlessTask || !windows || !knownDocumentsPath || !observedWorkspacePath
    ? true
    : isWithinWindowsPath(observedWorkspacePath, expectedProjectlessRoot)
const sandboxCoversWorkspace =
  !windows || !sandboxPermissionRoot || !observedWorkspacePath
    ? true
    : isWithinWindowsPath(observedWorkspacePath, sandboxPermissionRoot)
const knownFolderMismatch =
  windows &&
  projectlessTask &&
  Boolean(knownDocumentsPath) &&
  Boolean(observedWorkspacePath) &&
  !workspaceUnderKnownFolder
const sandboxPathMismatch = windows && Boolean(sandboxPermissionRoot) && Boolean(observedWorkspacePath) && !sandboxCoversWorkspace
const pathAuthorityMismatch = knownFolderMismatch || sandboxPathMismatch
const approvedReroute = new Set([
  "none",
  "explicit_canonical_windows_workspace",
  "approved_linux_vps",
  "authorized_local_linux",
]).has(rerouteTarget || "none")

let admitted = true
let reason = "windows_known_folder_authority_verified"
let exitCode = 0

if (!approvedReroute) {
  admitted = false
  reason = "unapproved_reroute_target"
  exitCode = 64
} else if (junctionModifiedOrRemoved) {
  admitted = false
  reason = "legacy_documents_junction_mutation_forbidden"
  exitCode = 64
} else if (pathAuthorityMismatch && !workspaceWriteIsolated) {
  admitted = false
  reason = "windows_workspace_path_authority_mismatch_not_isolated"
  exitCode = 75
} else if (pathAuthorityMismatch && !workspaceCheckpointPreserved) {
  admitted = false
  reason = "workspace_checkpoint_required_before_reroute"
  exitCode = 75
} else if (pathAuthorityMismatch && !uncertainWritesReconciled) {
  admitted = false
  reason = "workspace_path_uncertain_writes_not_reconciled"
  exitCode = 75
} else if (pathAuthorityMismatch && (rerouteTarget || "none") === "none") {
  admitted = false
  reason = "canonical_workspace_or_approved_executor_required"
  exitCode = 75
} else if (pathAuthorityMismatch && rerouteTarget === "explicit_canonical_windows_workspace") {
  if (!workspaceIdentityVerified || !sandboxPermissionRootVerified || !canonicalWorkspaceCanaryPassed) {
    admitted = false
    reason = "canonical_windows_workspace_not_verified"
    exitCode = 75
  } else {
    reason = "windows_workspace_path_mismatch_remediated"
  }
} else if (pathAuthorityMismatch) {
  reason = "windows_workspace_path_mismatch_contained"
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  platform,
  desktop_build: desktopBuild || null,
  projectless_task: projectlessTask,
  windows_known_documents_path: knownDocumentsPath || null,
  expected_projectless_root: expectedProjectlessRoot || null,
  observed_workspace_path: observedWorkspacePath || null,
  sandbox_permission_root: sandboxPermissionRoot || null,
  workspace_under_known_folder: workspaceUnderKnownFolder,
  sandbox_covers_workspace: sandboxCoversWorkspace,
  known_folder_mismatch: knownFolderMismatch,
  sandbox_path_mismatch: sandboxPathMismatch,
  path_authority_mismatch: pathAuthorityMismatch,
  legacy_documents_junction_present: junctionPresent,
  workspace_write_isolated: workspaceWriteIsolated,
  workspace_checkpoint_preserved: workspaceCheckpointPreserved,
  uncertain_writes_reconciled: uncertainWritesReconciled,
  workspace_identity_verified: workspaceIdentityVerified,
  sandbox_permission_root_verified: sandboxPermissionRootVerified,
  canonical_workspace_canary_passed: canonicalWorkspaceCanaryPassed,
  reroute_target: rerouteTarget || "none",
  protocol: admitted
    ? "Continue through direct OpenAI control with an explicitly verified canonical workspace or approved local/Linux executor. Keep the task, operation, checkpoint, workspace identity, Known Folder path, sandbox permission root, and write-reconciliation receipts authoritative."
    : "Stop only writes through the mismatched projectless Windows workspace. Preserve the task checkpoint, do not remove or rewrite the legacy Documents junction, reconcile uncertain writes, create one explicit workspace under the Windows Known Folder or use the approved local/Linux executor, verify sandbox coverage with disposable read/write canaries, and continue the exact unfinished action without replaying completed mutations.",
  resume_condition:
    "Resume Windows projectless workspace writes after the observed workspace resolves under the configured Windows Documents Known Folder, the sandbox permission root covers that exact canonical workspace, workspace identity is verified, and disposable read/write plus restart canaries pass without path drift.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
