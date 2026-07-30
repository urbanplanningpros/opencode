import fs from "node:fs"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, all) => {
  if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true])
  return acc
}, []))

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const fail = (reason, code = 2, detail) => {
  console.error(JSON.stringify({ admitted: false, reason, ...(detail ? { detail } : {}) }, null, 2))
  process.exit(code)
}

if (!args.input) fail("missing_input")

let evidence
try {
  const inputPath = path.resolve(String(args.input))
  const stat = fs.lstatSync(inputPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"))
} catch (error) {
  fail("invalid_evidence", 2, error.message)
}

if (prohibited.test(JSON.stringify({
  evidence,
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
}))) fail("prohibited_route_metadata", 64)

const asString = (value, name, required = false) => {
  if (value == null || value === "") {
    if (required) throw new Error(`${name} is required`)
    return ""
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}
const asBoolean = (value, name) => {
  if (value == null) return false
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}
const asArray = (value, name) => {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}
const asObject = (value, name) => {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

let taskId, operationId, idempotencyKey, parent, recovery, children
try {
  taskId = asString(evidence.task_id, "task_id", true)
  operationId = asString(evidence.operation_id, "operation_id", true)
  idempotencyKey = asString(evidence.idempotency_key, "idempotency_key", true)
  parent = asObject(evidence.parent_turn, "parent_turn")
  recovery = asObject(evidence.recovery, "recovery")
  children = asArray(evidence.children, "children").map((child, index) => {
    const value = asObject(child, `children[${index}]`)
    return {
      child_thread_id: asString(value.child_thread_id, `children[${index}].child_thread_id`, true),
      status_at_parent_completion: asString(value.status_at_parent_completion, `children[${index}].status_at_parent_completion`, true).toLowerCase(),
      current_status: asString(value.current_status, `children[${index}].current_status`, true).toLowerCase(),
      explicit_detach_requested: asBoolean(value.explicit_detach_requested, `children[${index}].explicit_detach_requested`),
      detach_receipt_verified: asBoolean(value.detach_receipt_verified, `children[${index}].detach_receipt_verified`),
      downstream_activity_after_parent_completion: asBoolean(value.downstream_activity_after_parent_completion, `children[${index}].downstream_activity_after_parent_completion`),
      result_collected: asBoolean(value.result_collected, `children[${index}].result_collected`),
      writes_reconciled: asBoolean(value.writes_reconciled, `children[${index}].writes_reconciled`),
      lifecycle_observable: asBoolean(value.lifecycle_observable, `children[${index}].lifecycle_observable`),
      completion_delivery_bound: asBoolean(value.completion_delivery_bound, `children[${index}].completion_delivery_bound`),
      supervisor_lease_active: asBoolean(value.supervisor_lease_active, `children[${index}].supervisor_lease_active`),
    }
  })
} catch (error) {
  fail("malformed_evidence", 2, error.message)
}

const terminalStates = new Set(["completed", "failed", "cancelled", "canceled", "shutdown"])
const nonTerminalStates = new Set(["pendinginit", "pending_init", "starting", "running", "in_progress", "waiting"])
const parentCompleted = asString(parent.status, "parent_turn.status").toLowerCase() === "completed" || asBoolean(parent.turn_completed_emitted, "parent_turn.turn_completed_emitted")
const parentFinalEmitted = asBoolean(parent.final_response_emitted, "parent_turn.final_response_emitted")
const waitAgentCalled = asBoolean(parent.wait_agent_called, "parent_turn.wait_agent_called")

const unresolvedAtBoundary = children.filter(child => nonTerminalStates.has(child.status_at_parent_completion))
const validDetached = children.filter(child => child.explicit_detach_requested && child.detach_receipt_verified)
const implicitDetach = parentCompleted && unresolvedAtBoundary.filter(child => !(child.explicit_detach_requested && child.detach_receipt_verified))
const structuredConcurrencyViolation = parentCompleted && parentFinalEmitted && implicitDetach.length > 0

const automaticReplay = asBoolean(recovery.automatic_parent_replay_attempted, "recovery.automatic_parent_replay_attempted")
const automaticRespawn = asBoolean(recovery.automatic_child_respawn_attempted, "recovery.automatic_child_respawn_attempted")
const replacementTaskCreated = asBoolean(recovery.replacement_task_created_before_reconciliation, "recovery.replacement_task_created_before_reconciliation")
const unsafeRecovery = structuredConcurrencyViolation && (automaticReplay || automaticRespawn || replacementTaskCreated)

const inventoryComplete = asBoolean(recovery.child_inventory_complete, "recovery.child_inventory_complete")
const parentStatePreserved = asBoolean(recovery.canonical_parent_state_preserved, "recovery.canonical_parent_state_preserved")
const externalWritesReconciled = asBoolean(recovery.external_writes_reconciled, "recovery.external_writes_reconciled")
const checkpointed = asBoolean(recovery.unfinished_action_checkpointed, "recovery.unfinished_action_checkpointed")
const newChildAdmissionBlocked = asBoolean(recovery.new_child_admission_blocked, "recovery.new_child_admission_blocked")
const route = asString(recovery.continuation_route, "recovery.continuation_route").toLowerCase()

const childStateReconciled = children.every(child => child.writes_reconciled && (
  terminalStates.has(child.current_status)
    ? child.result_collected || child.current_status !== "completed"
    : child.lifecycle_observable && child.completion_delivery_bound && child.supervisor_lease_active
))
const stillRunning = children.filter(child => !terminalStates.has(child.current_status))
const supervisedExistingChild = stillRunning.length > 0 && stillRunning.every(child => child.lifecycle_observable && child.completion_delivery_bound && child.supervisor_lease_active)

const allowedRoutes = new Set(["same_thread_reconcile", "guarded_single_agent", "approved_local", "approved_linux", "supervised_existing_child"])
const boundedRecovery = !structuredConcurrencyViolation || (
  inventoryComplete &&
  parentStatePreserved &&
  externalWritesReconciled &&
  checkpointed &&
  newChildAdmissionBlocked &&
  childStateReconciled &&
  allowedRoutes.has(route) &&
  (route !== "supervised_existing_child" || supervisedExistingChild)
)

let admitted = true
let reason = "parent_child_turn_continuity_verified"
let code = 0
if (unsafeRecovery) {
  admitted = false
  reason = "automatic_replay_respawn_or_replacement_forbidden"
  code = 64
} else if (!boundedRecovery) {
  admitted = false
  reason = "parent_completed_with_unresolved_child_state"
  code = 75
} else if (structuredConcurrencyViolation && supervisedExistingChild) {
  reason = "bounded_existing_child_supervision_active"
} else if (structuredConcurrencyViolation) {
  reason = "parent_child_state_reconciled"
}

const report = {
  admitted,
  reason,
  task_id: taskId,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  parent_turn: {
    parent_completed: parentCompleted,
    final_response_emitted: parentFinalEmitted,
    wait_agent_called: waitAgentCalled,
    owned_child_count: children.length,
    unresolved_at_parent_boundary: unresolvedAtBoundary.map(child => child.child_thread_id),
    explicitly_detached_children: validDetached.map(child => child.child_thread_id),
    implicit_detach_detected: structuredConcurrencyViolation,
  },
  child_state: {
    currently_nonterminal: stillRunning.map(child => child.child_thread_id),
    downstream_activity_after_parent_completion: children.filter(child => child.downstream_activity_after_parent_completion).map(child => child.child_thread_id),
    reconciled: childStateReconciled,
    supervised_existing_child: supervisedExistingChild,
  },
  continuation_route: route || null,
  protocol: admitted
    ? "Do not treat parent turn/completed as agent-tree completion. Preserve the parent ledger, keep new child admission blocked, supervise any existing child by exact thread ID, collect terminal results, reconcile durable writes, and continue only the exact unfinished action through the approved route."
    : "Isolate only the affected parent/child operation. Preserve the parent and child threads, operation and idempotency receipts, repository state, approvals, and external-write evidence. Do not replay the parent, respawn the child, or create a replacement task before reconciliation.",
  resume_condition: "Resume ordinary multi-agent admission only after every owned child is terminal or explicitly detached with a verified receipt, all child writes are reconciled, and parent completion reflects the resolved agent tree.",
}

console.log(JSON.stringify(report, null, 2))
process.exit(code)
