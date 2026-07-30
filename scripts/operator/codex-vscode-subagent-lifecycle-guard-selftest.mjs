import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-vscode-subagent-lifecycle-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-vscode-subagent-lifecycle-"))

const base = {
  operation_id: "op-agent-1",
  task_id: "task-agent-1",
  surface: {
    name: "vscode",
    extension_version: "26.721.41059",
    runtime_version: "0.146.0-alpha.3.1",
    multi_agent_enabled: true,
  },
  tool_schema: {
    available_tools: ["spawn_agent", "followup_task", "send_message", "interrupt_agent", "list_agents", "wait_agent", "close_agent"],
    verified_close_equivalent: "",
    interrupt_agent_used_as_close: false,
  },
  agent_tree: [],
  state: {
    new_agent_admission_requested: true,
    parent_completion_requested: false,
    automatic_replay_requested: false,
    replacement_thread_requested: false,
    task_state_preserved: true,
    external_writes_reconciled: true,
    authoritative_agent_tree_readback: true,
  },
  continuity_route: {
    type: "direct_openai_cli",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
    available_tools: ["spawn_agent", "wait_agent", "close_agent"],
    verified_close_equivalent: "",
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

run("healthy-complete-schema", structuredClone(base), 0, "subagent_lifecycle_schema_verified")

const missingCloseSingle = structuredClone(base)
missingCloseSingle.tool_schema.available_tools = missingCloseSingle.tool_schema.available_tools.filter((tool) => tool !== "close_agent")
missingCloseSingle.state.new_agent_admission_requested = false
missingCloseSingle.continuity_route.verified = false
run("missing-close-single-agent", missingCloseSingle, 0, "vscode_lifecycle_gap_isolated_single_agent_continuation")

const missingCloseSpawn = structuredClone(missingCloseSingle)
missingCloseSpawn.state.new_agent_admission_requested = true
run("missing-close-new-admission", missingCloseSpawn, 75, "vscode_close_agent_missing_new_admission_withheld")

const completedUnclosed = structuredClone(missingCloseSingle)
completedUnclosed.agent_tree = [{
  agent_id: "agent-1",
  status: "completed",
  result_collected: true,
  writes_reconciled: true,
  close_receipt_id: "",
}]
run("completed-agent-unreclaimed", completedUnclosed, 75, "completed_subagents_cannot_be_reclaimed_on_current_surface")

const verifiedFallback = structuredClone(completedUnclosed)
verifiedFallback.continuity_route.verified = true
run("verified-close-fallback", verifiedFallback, 0, "vscode_lifecycle_gap_contained_with_verified_close_route")

const interruptAsClose = structuredClone(base)
interruptAsClose.tool_schema.interrupt_agent_used_as_close = true
run("interrupt-not-close", interruptAsClose, 64, "interrupt_agent_is_not_lifecycle_closure")

const activeChildCompletion = structuredClone(base)
activeChildCompletion.state.new_agent_admission_requested = false
activeChildCompletion.state.parent_completion_requested = true
activeChildCompletion.agent_tree = [{
  agent_id: "agent-active",
  status: "running",
  result_collected: false,
  writes_reconciled: false,
  close_receipt_id: "",
}]
run("parent-completion-active-child", activeChildCompletion, 75, "parent_completion_blocked_by_unresolved_child_agents")

const replay = structuredClone(activeChildCompletion)
replay.state.parent_completion_requested = false
replay.state.automatic_replay_requested = true
run("replay-unresolved-agent", replay, 64, "automatic_replay_rejected_with_unresolved_agent_state")

const replacement = structuredClone(activeChildCompletion)
replacement.state.parent_completion_requested = false
replacement.state.replacement_thread_requested = true
run("replacement-unresolved-agent", replacement, 64, "replacement_thread_rejected_with_unresolved_agent_state")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
