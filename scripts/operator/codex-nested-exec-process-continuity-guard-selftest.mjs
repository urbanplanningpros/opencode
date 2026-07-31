import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-nested-exec-process-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-nested-exec-continuity-"))

const base = {
  operation_id: "op-nested-1",
  parent_execution_id: "cell-parent-1",
  nested_execs: [
    {
      call_id: "exec-1",
      command_class: "mutating",
      outer_status: "completed",
      child_status: "completed",
      session_id: "session-1",
      session_id_retained: true,
      child_process_alive: false,
      process_handle_owned: true,
      exact_process_identity_verified: true,
      writes_reconciled: true,
      completion_receipt: true,
    },
  ],
  state: {
    parent_completion_requested: true,
    automatic_replay_requested: false,
    new_mutation_requested: false,
    task_state_preserved: true,
    filesystem_state_preserved: true,
    workspace_snapshot_recorded: true,
    git_checkpoint_created: true,
    external_writes_reconciled: true,
    exact_child_termination_requested: false,
    broad_process_kill_requested: false,
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

run("completed", structuredClone(base), 0, "nested_exec_lifecycle_verified")

const tracked = structuredClone(base)
tracked.state.parent_completion_requested = false
tracked.nested_execs[0].outer_status = "yielded"
tracked.nested_execs[0].child_status = "running"
tracked.nested_execs[0].child_process_alive = true
tracked.nested_execs[0].writes_reconciled = false
tracked.nested_execs[0].completion_receipt = false
run("tracked-live-child", tracked, 0, "live_nested_exec_tracked")

const contained = structuredClone(tracked)
contained.nested_execs[0].outer_status = "completed"
contained.nested_execs[0].session_id = ""
contained.nested_execs[0].session_id_retained = false
contained.nested_execs[0].process_handle_owned = false
contained.nested_execs[0].exact_process_identity_verified = false
contained.nested_execs[0].writes_reconciled = true
contained.state.external_writes_reconciled = true
run("orphan-contained", contained, 0, "orphaned_nested_exec_contained")

const parentComplete = structuredClone(tracked)
parentComplete.state.parent_completion_requested = true
run("parent-completion-live", parentComplete, 75, "parent_completion_blocked_by_live_nested_exec")

const newMutation = structuredClone(tracked)
newMutation.state.new_mutation_requested = true
run("new-mutation-live", newMutation, 75, "new_mutation_blocked_until_nested_exec_reconciled")

const replay = structuredClone(tracked)
replay.state.automatic_replay_requested = true
run("replay-live", replay, 64, "automatic_replay_rejected_with_live_or_unreconciled_nested_exec")

const broadKill = structuredClone(base)
broadKill.state.broad_process_kill_requested = true
run("broad-kill", broadKill, 64, "broad_process_kill_rejected")

const unsafeTerminate = structuredClone(contained)
unsafeTerminate.state.exact_child_termination_requested = true
run("unsafe-termination", unsafeTerminate, 64, "exact_child_termination_requires_owned_process_identity")

const noCheckpoint = structuredClone(contained)
noCheckpoint.state.workspace_snapshot_recorded = false
run("orphan-no-checkpoint", noCheckpoint, 75, "orphaned_nested_exec_requires_filesystem_checkpoint")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
