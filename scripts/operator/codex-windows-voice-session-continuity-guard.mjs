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

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} must be a regular non-symlink file`)
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function optionalObject(value, name) {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i

if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const routingMetadata = JSON.stringify({
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
  evidence,
})

if (prohibited.test(routingMetadata)) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let taskId
let operationId
let platform
let desktopBuild
let authorityBearingTask
let uncertainWritesReconciled
let voice
let continuationRoute

try {
  taskId = nonEmptyString(evidence.task_id, "task_id")
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  platform = nonEmptyString(evidence.platform, "platform").toLowerCase()
  desktopBuild = nonEmptyString(evidence.desktop_build, "desktop_build")
  authorityBearingTask = boolean(evidence.authority_bearing_task, "authority_bearing_task")
  uncertainWritesReconciled = boolean(evidence.uncertain_writes_reconciled, "uncertain_writes_reconciled")
  voice = optionalObject(evidence.voice_shortcut, "voice_shortcut")
  continuationRoute = optionalString(evidence.continuation_route, "continuation_route").toLowerCase()
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const affectedBuild = platform === "windows" && desktopBuild === "26.721.4979.0"

const shortcutInvoked = voice.invoked === true
const shortcutSource = optionalString(voice.source, "voice_shortcut.source").toLowerCase()
const nativeShortcutEnabled = boolean(voice.native_shortcut_enabled, "voice_shortcut.native_shortcut_enabled")
const nativeShortcutIsolated = boolean(voice.native_shortcut_isolated, "voice_shortcut.native_shortcut_isolated")
const sourceThreadId = optionalString(voice.source_thread_id, "voice_shortcut.source_thread_id")
const voiceThreadId = optionalString(voice.voice_thread_id, "voice_shortcut.voice_thread_id")
const voiceThreadProjectless = boolean(voice.voice_thread_projectless, "voice_shortcut.voice_thread_projectless")
const sourceArchiveRequested = boolean(voice.source_archive_requested, "voice_shortcut.source_archive_requested")
const archiveTargetThreadId = optionalString(voice.archive_target_thread_id, "voice_shortcut.archive_target_thread_id")
const sourceArchived = boolean(voice.source_archived, "voice_shortcut.source_archived")
const sourceVisibleInNormalHistory = boolean(
  voice.source_visible_in_normal_history,
  "voice_shortcut.source_visible_in_normal_history",
)
const sourceHistoryFoundInArchive = boolean(
  voice.source_history_found_in_archive,
  "voice_shortcut.source_history_found_in_archive",
)
const sourceUnarchived = boolean(voice.source_unarchived, "voice_shortcut.source_unarchived")
const sourceThreadIdentityVerified = boolean(
  voice.source_thread_identity_verified,
  "voice_shortcut.source_thread_identity_verified",
)
const sourceStateVerified = boolean(voice.source_state_verified, "voice_shortcut.source_state_verified")
const duplicateWorkStarted = boolean(voice.duplicate_work_started, "voice_shortcut.duplicate_work_started")
const replacementThreadUsed = boolean(voice.replacement_thread_used, "voice_shortcut.replacement_thread_used")

const nativeAccelerator = shortcutSource === "native_accelerator"
const sourceArchiveTargeted =
  sourceArchiveRequested &&
  sourceThreadId !== "" &&
  archiveTargetThreadId !== "" &&
  archiveTargetThreadId === sourceThreadId

const sourceDisappeared = sourceArchived || (shortcutInvoked && !sourceVisibleInNormalHistory)
const sourceRecoveryRequired = affectedBuild && shortcutInvoked && (sourceArchiveRequested || sourceDisappeared)

const voiceIdentityMissing =
  affectedBuild &&
  shortcutInvoked &&
  (!nativeAccelerator || !sourceThreadId || !voiceThreadId || !voiceThreadProjectless)

const authorityShortcutNotIsolated =
  affectedBuild && authorityBearingTask && nativeShortcutEnabled && !nativeShortcutIsolated

const unsafeContinuation = duplicateWorkStarted || replacementThreadUsed

const sourceRecoveryIncomplete =
  sourceRecoveryRequired &&
  (!sourceArchiveTargeted ||
    !sourceHistoryFoundInArchive ||
    !sourceUnarchived ||
    !sourceThreadIdentityVerified ||
    !sourceStateVerified ||
    !uncertainWritesReconciled)

const continuationRouteValid = new Set(["same_source_thread", "approved_local", "approved_linux"]).has(
  continuationRoute,
)

const sourceRecoveryRouteMissing = sourceRecoveryRequired && !continuationRouteValid

let admitted = true
let reason = "windows_voice_session_continuity_verified"
let exitCode = 0

if (unsafeContinuation) {
  admitted = false
  reason = duplicateWorkStarted
    ? "duplicate_work_after_voice_fork_forbidden"
    : "replacement_thread_after_voice_fork_forbidden"
  exitCode = 64
} else if (voiceIdentityMissing) {
  admitted = false
  reason = "voice_fork_identity_incomplete"
  exitCode = 75
} else if (sourceRecoveryIncomplete) {
  admitted = false
  reason = "source_thread_archive_recovery_incomplete"
  exitCode = 75
} else if (sourceRecoveryRouteMissing) {
  admitted = false
  reason = "source_thread_continuation_route_unverified"
  exitCode = 75
} else if (authorityShortcutNotIsolated) {
  admitted = false
  reason = "native_voice_shortcut_not_isolated"
  exitCode = 75
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  platform,
  desktop_build: desktopBuild,
  affected_build: affectedBuild,
  authority_bearing_task: authorityBearingTask,
  uncertain_writes_reconciled: uncertainWritesReconciled,
  voice_shortcut: {
    invoked: shortcutInvoked,
    source: shortcutSource || null,
    native_shortcut_enabled: nativeShortcutEnabled,
    native_shortcut_isolated: nativeShortcutIsolated,
    source_thread_id: sourceThreadId || null,
    voice_thread_id: voiceThreadId || null,
    voice_thread_projectless: voiceThreadProjectless,
    source_archive_requested: sourceArchiveRequested,
    archive_target_thread_id: archiveTargetThreadId || null,
    source_archive_targeted: sourceArchiveTargeted,
    source_archived: sourceArchived,
    source_visible_in_normal_history: sourceVisibleInNormalHistory,
    source_history_found_in_archive: sourceHistoryFoundInArchive,
    source_unarchived: sourceUnarchived,
    source_thread_identity_verified: sourceThreadIdentityVerified,
    source_state_verified: sourceStateVerified,
    duplicate_work_started: duplicateWorkStarted,
    replacement_thread_used: replacementThreadUsed,
  },
  continuation_route: continuationRoute || null,
  protocol: admitted
    ? "Continue the exact source task. Keep the native voice accelerator isolated for authority-bearing Windows tasks on the affected build, preserve the source thread ID and operation ledger, and use only the same source thread or an approved local/Linux execution route."
    : "Stop only the affected voice shortcut or source-task continuation. Do not continue in the voice-created task and do not start replacement work. Locate the exact source thread in Archived tasks, unarchive it, verify thread identity, repository and external-write state, reconcile uncertain writes, isolate the native voice shortcut, and continue the exact unfinished action in the same source thread or approved local/Linux route.",
  resume_condition:
    "Resume after the exact source thread is visible and unarchived, its identity and state are verified, uncertain writes are reconciled, no duplicate or replacement work has started, and the native voice shortcut is isolated for authority-bearing tasks on Windows Desktop build 26.721.4979.0.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
