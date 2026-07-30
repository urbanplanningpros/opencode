import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-sidebar-continuation-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sidebar-continuation-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason)
}

const base = {
  app_build: "26.721.41059",
  source_thread_id: "019fb099-4395-7262-bc53-b8658a0cda16",
  operation_id: "operation-123",
  repository_sha: "a".repeat(40),
  diff_sha256: "b".repeat(64),
  continuation_attempted: true,
  continuation_mode: "same_workspace",
  continuation_route: "native",
  no_rollout_found: false,
  source_rollout_verified: true,
  source_thread_preserved: true,
  source_checkpoint_exported: false,
  target_task_created: true,
  target_task_id: "task-456",
  target_task_indexed: true,
  target_workspace_verified: true,
  target_worktree_initialized: false,
  repository_state_verified: true,
  external_writes_reconciled: true,
  automatic_retry_attempted: false,
  replacement_task_created: false,
  duplicate_continuation_created: false,
}

run("native-safe", base, 0, "sidebar_continuation_verified")
run(
  "no-rollout-native",
  { ...base, no_rollout_found: true, source_rollout_verified: false, target_task_created: false, target_task_id: "", target_task_indexed: false },
  75,
  "sidebar_continuation_rollout_unavailable",
)
run(
  "no-rollout-auto-retry",
  { ...base, no_rollout_found: true, source_rollout_verified: false, automatic_retry_attempted: true },
  64,
  "sidebar_continuation_replay_forbidden",
)
run(
  "checkpoint-missing-target",
  {
    ...base,
    no_rollout_found: true,
    source_rollout_verified: false,
    continuation_route: "checkpoint_same_workspace",
    source_checkpoint_exported: true,
    source_checkpoint_sha256: "c".repeat(64),
    target_task_created: false,
    target_task_id: "",
    target_task_indexed: false,
  },
  75,
  "sidebar_continuation_checkpoint_unverified",
)
run(
  "checkpoint-same-workspace-safe",
  {
    ...base,
    no_rollout_found: true,
    source_rollout_verified: false,
    continuation_route: "checkpoint_same_workspace",
    source_checkpoint_exported: true,
    source_checkpoint_sha256: "c".repeat(64),
  },
  0,
  "sidebar_continuation_verified",
)
run(
  "checkpoint-new-worktree-uninitialized",
  {
    ...base,
    continuation_mode: "new_worktree",
    no_rollout_found: true,
    source_rollout_verified: false,
    continuation_route: "checkpoint_new_worktree",
    source_checkpoint_exported: true,
    source_checkpoint_sha256: "c".repeat(64),
    target_worktree_initialized: false,
  },
  75,
  "sidebar_continuation_checkpoint_unverified",
)
run(
  "checkpoint-new-worktree-safe",
  {
    ...base,
    continuation_mode: "new_worktree",
    no_rollout_found: true,
    source_rollout_verified: false,
    continuation_route: "checkpoint_new_worktree",
    source_checkpoint_exported: true,
    source_checkpoint_sha256: "c".repeat(64),
    target_worktree_initialized: true,
  },
  0,
  "sidebar_continuation_verified",
)
run(
  "approved-linux-fallback-safe",
  {
    ...base,
    no_rollout_found: true,
    source_rollout_verified: false,
    continuation_route: "approved_linux",
    source_checkpoint_exported: true,
    source_checkpoint_sha256: "c".repeat(64),
    target_task_created: false,
    target_task_id: "",
    target_task_indexed: false,
    target_workspace_verified: false,
  },
  0,
  "sidebar_continuation_verified",
)
run(
  "unreconciled-writes",
  { ...base, external_writes_reconciled: false },
  75,
  "sidebar_continuation_writes_unreconciled",
)
run(
  "prohibited-route",
  { ...base, continuation_route: "native", note: "automatic gateway selector" },
  64,
  "prohibited_route_metadata",
)

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex sidebar continuation guard self-test passed")
