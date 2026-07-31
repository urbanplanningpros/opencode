import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-windows-mcp-process-ownership-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-mcp-process-ownership-"))

const base = {
  operation_id: "op-mcp-1",
  host: {
    platform: "windows",
    pid: 100,
    creation_identity: "100:1785470000000",
    ancestors_excluded_from_termination: true,
    sibling_processes_excluded_from_termination: true,
  },
  mcp_process: {
    pid: 200,
    termination_method: "job_object",
    job_object_assigned: true,
    job_kill_on_close: true,
    direct_child_handle_owned: true,
    suspended_assignment_used: true,
    graceful_shutdown_attempted: true,
    process_creation_identity_verified: true,
    stale_parent_edges_rejected: true,
    cycle_detection_passed: true,
  },
  state: {
    task_state_preserved: true,
    external_writes_reconciled: true,
    automatic_retry_requested: false,
    broad_host_restart_requested: false,
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
  const parsed = JSON.parse(stream)
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("owned-job", structuredClone(base), 0, "mcp_process_ownership_verified")

const direct = structuredClone(base)
direct.mcp_process.termination_method = "direct_child_handle"
direct.mcp_process.job_object_assigned = false
direct.mcp_process.job_kill_on_close = false
direct.mcp_process.suspended_assignment_used = false
run("owned-direct-child", direct, 0, "mcp_process_ownership_verified")

const taskkill = structuredClone(base)
taskkill.mcp_process.termination_method = "taskkill_tree"
run("reject-taskkill-tree", taskkill, 75, "numeric_pid_tree_termination_rejected")

const noOwnership = structuredClone(base)
noOwnership.mcp_process.job_object_assigned = false
run("reject-no-ownership", noOwnership, 75, "mcp_termination_lacks_durable_process_ownership")

const staleEdges = structuredClone(base)
staleEdges.mcp_process.stale_parent_edges_rejected = false
run("reject-stale-parent-edge", staleEdges, 75, "host_or_sibling_process_exclusion_not_proven")

const cycle = structuredClone(base)
cycle.mcp_process.cycle_detection_passed = false
run("reject-cycle-risk", cycle, 75, "host_or_sibling_process_exclusion_not_proven")

const ancestor = structuredClone(base)
ancestor.host.ancestors_excluded_from_termination = false
run("reject-ancestor-risk", ancestor, 75, "host_or_sibling_process_exclusion_not_proven")

const noGrace = structuredClone(base)
noGrace.mcp_process.graceful_shutdown_attempted = false
run("require-graceful-shutdown", noGrace, 75, "bounded_graceful_shutdown_required_before_forced_termination")

const retry = structuredClone(base)
retry.state.automatic_retry_requested = true
retry.state.external_writes_reconciled = false
run("reject-broad-retry", retry, 64, "broad_retry_or_restart_rejected_before_write_reconciliation")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
