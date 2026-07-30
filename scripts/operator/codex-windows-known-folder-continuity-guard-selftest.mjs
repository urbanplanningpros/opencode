import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "codex-windows-known-folder-continuity-guard.mjs",
)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-known-folder-continuity-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const file = path.join(temporary, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason)
}

const base = {
  task_id: "task-36105",
  operation_id: "operation-36105",
  platform: "Windows 11 x64",
  desktop_build: "26.721.11231.0",
  projectless_task: true,
  windows_known_documents_path: "D:\\Users\\operator\\Documents",
  observed_workspace_path: "D:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
  sandbox_permission_root: "D:\\Users\\operator\\Documents\\Codex",
  legacy_documents_junction_present: true,
  legacy_documents_junction_modified_or_removed: false,
  workspace_write_isolated: false,
  workspace_checkpoint_preserved: true,
  uncertain_writes_reconciled: true,
  workspace_identity_verified: true,
  sandbox_permission_root_verified: true,
  canonical_workspace_canary_passed: true,
  reroute_target: "none",
}

run("canonical", base, 0, "windows_known_folder_authority_verified")
run(
  "mismatch-not-isolated",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
  },
  75,
  "windows_workspace_path_authority_mismatch_not_isolated",
)
run(
  "checkpoint-missing",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
    workspace_checkpoint_preserved: false,
  },
  75,
  "workspace_checkpoint_required_before_reroute",
)
run(
  "writes-unreconciled",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
    uncertain_writes_reconciled: false,
  },
  75,
  "workspace_path_uncertain_writes_not_reconciled",
)
run(
  "no-route",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
  },
  75,
  "canonical_workspace_or_approved_executor_required",
)
run(
  "canonical-route-unverified",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
    reroute_target: "explicit_canonical_windows_workspace",
    canonical_workspace_canary_passed: false,
  },
  75,
  "canonical_windows_workspace_not_verified",
)
run(
  "canonical-route-remediated",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
    reroute_target: "explicit_canonical_windows_workspace",
  },
  0,
  "windows_workspace_path_mismatch_remediated",
)
run(
  "linux-contained",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
    reroute_target: "approved_linux_vps",
  },
  0,
  "windows_workspace_path_mismatch_contained",
)
run(
  "sandbox-root-mismatch",
  {
    ...base,
    sandbox_permission_root: "C:\\Users\\operator\\Documents\\Codex",
    workspace_write_isolated: true,
    reroute_target: "authorized_local_linux",
  },
  0,
  "windows_workspace_path_mismatch_contained",
)
run(
  "junction-mutation",
  {
    ...base,
    legacy_documents_junction_modified_or_removed: true,
  },
  64,
  "legacy_documents_junction_mutation_forbidden",
)
run(
  "prohibited-route",
  {
    ...base,
    observed_workspace_path: "C:\\Users\\operator\\Documents\\Codex\\2026-07-30\\new-chat-3",
    workspace_write_isolated: true,
    reroute_target: "automatic model gateway selector",
  },
  64,
  "prohibited_route_metadata",
)

fs.rmSync(temporary, { recursive: true, force: true })
console.log("codex Windows Known Folder continuity guard self-test passed")
