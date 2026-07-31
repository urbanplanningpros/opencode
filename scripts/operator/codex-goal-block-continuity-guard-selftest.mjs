import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-goal-block-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-block-continuity-"))

const base = {
  operation_id: "op-goal-1",
  goal_id: "goal-1",
  goal: {
    current_status: "active",
    requested_transition: "continue",
    user_continue_requested: false,
  },
  dependency: {
    description: "",
    blocked_acceptance_condition: "",
    required_external_change: "",
    recoverable: false,
    branch_scoped: false,
  },
  critical_path: {
    required_now: false,
    parent_acceptance_blocked: false,
  },
  remaining_work: [
    { branch_id: "build", executable: true, independent_of_dependency: true },
  ],
  routes: [
    { type: "direct_openai_cli", authorized: true, available: true, attempted: false, exhausted: false },
  ],
  state: {
    task_state_preserved: true,
    external_writes_reconciled: true,
    branch_deferred_recorded: true,
    parent_block_justification_recorded: false,
    automatic_replay_requested: false,
    replacement_goal_requested: false,
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

run("active-goal", structuredClone(base), 0, "goal_continuity_verified")

const independentWork = structuredClone(base)
independentWork.goal.requested_transition = "blocked"
run("reject-independent-work-block", independentWork, 75, "parent_block_rejected_with_executable_independent_work")

const routeRemaining = structuredClone(base)
routeRemaining.goal.requested_transition = "blocked"
routeRemaining.remaining_work = []
routeRemaining.critical_path.required_now = true
routeRemaining.critical_path.parent_acceptance_blocked = true
routeRemaining.dependency.description = "credential unavailable"
routeRemaining.dependency.blocked_acceptance_condition = "production deploy"
routeRemaining.dependency.required_external_change = "credential restored"
run("reject-unexhausted-route", routeRemaining, 75, "parent_block_rejected_with_authorized_route_remaining")

const recoverable = structuredClone(routeRemaining)
recoverable.routes[0].attempted = true
recoverable.routes[0].exhausted = true
recoverable.dependency.recoverable = true
recoverable.dependency.branch_scoped = true
run("reject-recoverable-parent-block", recoverable, 75, "recoverable_or_branch_scoped_dependency_cannot_block_parent_goal")

const blockedBypass = structuredClone(base)
blockedBypass.goal.current_status = "blocked"
blockedBypass.goal.user_continue_requested = true
run("bypass-stale-blocked-ui", blockedBypass, 0, "blocked_goal_ui_bypassed_with_verified_continuity_route")

const blockedNoRoute = structuredClone(blockedBypass)
blockedNoRoute.continuity_route.canary_passed = false
run("blocked-ui-needs-route", blockedNoRoute, 75, "blocked_goal_requires_verified_continuity_route")

const replay = structuredClone(base)
replay.state.automatic_replay_requested = true
replay.state.external_writes_reconciled = false
run("reject-automatic-replay", replay, 64, "goal_replay_or_replacement_rejected_before_write_reconciliation")

const replacement = structuredClone(base)
replacement.state.replacement_goal_requested = true
replacement.state.task_state_preserved = false
run("reject-replacement-goal", replacement, 64, "goal_replay_or_replacement_rejected_before_write_reconciliation")

const legitimateBlock = structuredClone(routeRemaining)
legitimateBlock.routes[0].attempted = true
legitimateBlock.routes[0].exhausted = true
legitimateBlock.state.parent_block_justification_recorded = true
run("legitimate-parent-block", legitimateBlock, 0, "parent_goal_block_supported_by_exhaustion_evidence")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
