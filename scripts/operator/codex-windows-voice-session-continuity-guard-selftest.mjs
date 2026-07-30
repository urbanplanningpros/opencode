import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "codex-windows-voice-session-continuity-guard.mjs",
)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-voice-session-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason)
}

const base = {
  task_id: "task-source-123",
  operation_id: "operation-123",
  platform: "windows",
  desktop_build: "26.721.4979.0",
  authority_bearing_task: true,
  uncertain_writes_reconciled: true,
  continuation_route: "same_source_thread",
  voice_shortcut: {
    invoked: false,
    source: "native_accelerator",
    native_shortcut_enabled: false,
    native_shortcut_isolated: true,
    source_thread_id: "thread-source-123",
    voice_thread_id: "thread-voice-456",
    voice_thread_projectless: true,
    source_archive_requested: false,
    archive_target_thread_id: "",
    source_archived: false,
    source_visible_in_normal_history: true,
    source_history_found_in_archive: false,
    source_unarchived: false,
    source_thread_identity_verified: true,
    source_state_verified: true,
    duplicate_work_started: false,
    replacement_thread_used: false,
  },
}

run("safe", base, 0, "windows_voice_session_continuity_verified")

run(
  "shortcut-not-isolated",
  {
    ...base,
    voice_shortcut: {
      ...base.voice_shortcut,
      native_shortcut_enabled: true,
      native_shortcut_isolated: false,
    },
  },
  75,
  "native_voice_shortcut_not_isolated",
)

run(
  "archive-recovery-incomplete",
  {
    ...base,
    voice_shortcut: {
      ...base.voice_shortcut,
      invoked: true,
      source_archive_requested: true,
      archive_target_thread_id: "thread-source-123",
      source_archived: true,
      source_visible_in_normal_history: false,
      source_history_found_in_archive: true,
      source_unarchived: false,
      source_thread_identity_verified: false,
      source_state_verified: false,
    },
  },
  75,
  "source_thread_archive_recovery_incomplete",
)

run(
  "archive-recovery-safe",
  {
    ...base,
    voice_shortcut: {
      ...base.voice_shortcut,
      invoked: true,
      source_archive_requested: true,
      archive_target_thread_id: "thread-source-123",
      source_archived: true,
      source_visible_in_normal_history: false,
      source_history_found_in_archive: true,
      source_unarchived: true,
      source_thread_identity_verified: true,
      source_state_verified: true,
    },
  },
  0,
  "windows_voice_session_continuity_verified",
)

run(
  "unreconciled-writes",
  {
    ...base,
    uncertain_writes_reconciled: false,
    voice_shortcut: {
      ...base.voice_shortcut,
      invoked: true,
      source_archive_requested: true,
      archive_target_thread_id: "thread-source-123",
      source_archived: true,
      source_visible_in_normal_history: false,
      source_history_found_in_archive: true,
      source_unarchived: true,
      source_thread_identity_verified: true,
      source_state_verified: true,
    },
  },
  75,
  "source_thread_archive_recovery_incomplete",
)

run(
  "duplicate-work",
  {
    ...base,
    voice_shortcut: {
      ...base.voice_shortcut,
      invoked: true,
      duplicate_work_started: true,
    },
  },
  64,
  "duplicate_work_after_voice_fork_forbidden",
)

run(
  "replacement-thread",
  {
    ...base,
    voice_shortcut: {
      ...base.voice_shortcut,
      invoked: true,
      replacement_thread_used: true,
    },
  },
  64,
  "replacement_thread_after_voice_fork_forbidden",
)

run(
  "voice-identity-missing",
  {
    ...base,
    voice_shortcut: {
      ...base.voice_shortcut,
      invoked: true,
      voice_thread_id: "",
    },
  },
  75,
  "voice_fork_identity_incomplete",
)

run(
  "prohibited-route",
  { ...base, route: "automatic gateway selector" },
  64,
  "prohibited_route_metadata",
)

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Windows voice session continuity guard self-test passed")
