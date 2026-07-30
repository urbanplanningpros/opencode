import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-parent-child-turn-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parent-child-turn-"))

const base = {
  task_id: "task-1",
  operation_id: "op-1",
  idempotency_key: "idem-1",
  parent_turn: {
    status: "completed",
    turn_completed_emitted: true,
    final_response_emitted: true,
    wait_agent_called: true,
  },
  children: [{
    child_thread_id: "child-1",
    status_at_parent_completion: "completed",
    current_status: "completed",
    explicit_detach_requested: false,
    detach_receipt_verified: false,
    downstream_activity_after_parent_completion: false,
    result_collected: true,
    writes_reconciled: true,
    lifecycle_observable: true,
    completion_delivery_bound: true,
    supervisor_lease_active: false,
  }],
  recovery: {
    child_inventory_complete: true,
    canonical_parent_state_preserved: true,
    external_writes_reconciled: true,
    unfinished_action_checkpointed: true,
    new_child_admission_blocked: true,
    automatic_parent_replay_attempted: false,
    automatic_child_respawn_attempted: false,
    replacement_task_created_before_reconciliation: false,
    continuation_route: "same_thread_reconcile",
  },
}

const run = (name, evidence, expectedCode, expectedReason) => {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("healthy-terminal-child", structuredClone(base), 0, "parent_child_turn_continuity_verified")

const implicit = structuredClone(base)
implicit.parent_turn.wait_agent_called = false
implicit.children[0].status_at_parent_completion = "pendingInit"
implicit.children[0].current_status = "running"
implicit.children[0].result_collected = false
implicit.children[0].lifecycle_observable = false
implicit.children[0].completion_delivery_bound = false
implicit.children[0].supervisor_lease_active = false
implicit.recovery.child_inventory_complete = false
implicit.recovery.external_writes_reconciled = false
implicit.recovery.unfinished_action_checkpointed = false
implicit.recovery.new_child_admission_blocked = false
implicit.recovery.continuation_route = ""
run("implicit-detach-unreconciled", implicit, 75, "parent_completed_with_unresolved_child_state")

const supervised = structuredClone(implicit)
supervised.children[0].writes_reconciled = true
supervised.children[0].lifecycle_observable = true
supervised.children[0].completion_delivery_bound = true
supervised.children[0].supervisor_lease_active = true
supervised.recovery.child_inventory_complete = true
supervised.recovery.external_writes_reconciled = true
supervised.recovery.unfinished_action_checkpointed = true
supervised.recovery.new_child_admission_blocked = true
supervised.recovery.continuation_route = "supervised_existing_child"
run("supervised-existing-child", supervised, 0, "bounded_existing_child_supervision_active")

const reconciled = structuredClone(implicit)
reconciled.children[0].current_status = "completed"
reconciled.children[0].result_collected = true
reconciled.children[0].writes_reconciled = true
reconciled.children[0].lifecycle_observable = true
reconciled.children[0].completion_delivery_bound = true
reconciled.recovery.child_inventory_complete = true
reconciled.recovery.external_writes_reconciled = true
reconciled.recovery.unfinished_action_checkpointed = true
reconciled.recovery.new_child_admission_blocked = true
reconciled.recovery.continuation_route = "guarded_single_agent"
run("reconciled-child", reconciled, 0, "parent_child_state_reconciled")

const unknownWrite = structuredClone(supervised)
unknownWrite.children[0].writes_reconciled = false
run("unknown-child-write", unknownWrite, 75, "parent_completed_with_unresolved_child_state")

const respawn = structuredClone(supervised)
respawn.recovery.automatic_child_respawn_attempted = true
run("automatic-respawn", respawn, 64, "automatic_replay_respawn_or_replacement_forbidden")

const detached = structuredClone(base)
detached.parent_turn.wait_agent_called = false
detached.children[0].status_at_parent_completion = "running"
detached.children[0].current_status = "running"
detached.children[0].explicit_detach_requested = true
detached.children[0].detach_receipt_verified = true
detached.children[0].result_collected = false
detached.children[0].lifecycle_observable = true
detached.children[0].completion_delivery_bound = true
detached.children[0].supervisor_lease_active = true
detached.recovery.continuation_route = "supervised_existing_child"
run("explicit-detach", detached, 0, "parent_child_turn_continuity_verified")

const prohibited = structuredClone(base)
prohibited.recovery.continuation_route = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 7 }, null, 2))
