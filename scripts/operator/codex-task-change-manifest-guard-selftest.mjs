import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-task-change-manifest-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-task-change-manifest-"))

const base = {
  operation_id: "op-manifest-1",
  parent_task_id: "task-parent-1",
  repositories: [
    {
      name: "app",
      git_changed_files: [
        { repository: "app", path: "src/main.ts" },
        { repository: "app", path: "src/worker.ts" },
      ],
    },
  ],
  agent_tree: [
    {
      agent_id: "child-1",
      status: "completed",
      result_collected: true,
      writes_reconciled: true,
      changed_files: [{ repository: "app", path: "src/worker.ts" }],
    },
  ],
  ui_review: {
    parent_edited_files: [
      { repository: "app", path: "src/main.ts" },
      { repository: "app", path: "src/worker.ts" },
    ],
    authoritative: false,
    undo_scope_verified: true,
    multi_repository_review: true,
  },
  state: {
    parent_completion_requested: true,
    automatic_undo_requested: false,
    automatic_replay_requested: false,
    task_state_preserved: true,
    external_writes_reconciled: true,
    git_checkpoint_created: true,
    authoritative_manifest_recorded: true,
  },
  continuity_route: {
    type: "direct_openai_cli",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("complete-manifest", structuredClone(base), 0, "task_change_manifest_verified")

const missingUi = structuredClone(base)
missingUi.ui_review.parent_edited_files = [{ repository: "app", path: "src/main.ts" }]
run("missing-ui-contained", missingUi, 0, "incomplete_parent_review_contained_by_authoritative_manifest")

const missingNoReceipt = structuredClone(missingUi)
missingNoReceipt.state.authoritative_manifest_recorded = false
run("missing-ui-no-receipt", missingNoReceipt, 75, "subagent_changes_missing_from_parent_review")

const uiClaim = structuredClone(missingUi)
uiClaim.ui_review.authoritative = true
run("ui-authority-rejected", uiClaim, 75, "parent_review_surface_is_not_authoritative")

const undo = structuredClone(missingUi)
undo.state.automatic_undo_requested = true
undo.ui_review.undo_scope_verified = false
run("unsafe-undo", undo, 64, "automatic_undo_rejected_for_incomplete_task_change_manifest")

const activeChild = structuredClone(base)
activeChild.agent_tree[0].status = "running"
activeChild.agent_tree[0].result_collected = false
activeChild.agent_tree[0].writes_reconciled = false
run("parent-completion-active-child", activeChild, 75, "parent_completion_blocked_by_unresolved_subagent_changes")

const replay = structuredClone(activeChild)
replay.state.parent_completion_requested = false
replay.state.automatic_replay_requested = true
run("replay-unresolved", replay, 64, "automatic_replay_rejected_with_unresolved_change_state")

const multiRepo = structuredClone(base)
multiRepo.repositories.push({
  name: "infra",
  git_changed_files: [{ repository: "infra", path: "deploy/main.tf" }],
})
multiRepo.ui_review.parent_edited_files.push({ repository: "infra", path: "deploy/main.tf" })
multiRepo.ui_review.multi_repository_review = false
run("multi-repo-review-required", multiRepo, 75, "multi_repository_task_requires_cross_repository_manifest")

const routeMissing = structuredClone(missingUi)
routeMissing.continuity_route.verified = false
run("continuity-route-required", routeMissing, 75, "incomplete_ui_review_requires_verified_continuity_route")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
