import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-windows-readonly-node-runtime-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-readonly-node-"))

const base = {
  operation_id: "op-node-1",
  runtime: {
    platform: "windows",
    permission_mode: "read-only",
    node_repl_exposed: true,
    browser_depends_on_node: true,
    kernel_staging_path: "C:/CodexRuntime/op-node-1/kernel.js",
    staged_under_host_temp: false,
    sandbox_identity: "HOST/CodexSandboxOffline",
    kernel_readable_by_sandbox: true,
    module_not_found_observed: false,
    package_hashes_verified: true,
    minimal_node_canary_passed: true,
    browser_canary_passed: true,
  },
  remediation: {
    per_execution_sandbox_visible_directory: true,
    narrow_read_execute_grant: false,
    grant_bound_to_exact_directory: false,
    cleanup_receipt: true,
    broad_temp_acl_requested: false,
    full_access_escalation_requested: false,
    repeated_kernel_reset_requested: false,
  },
  state: {
    task_state_preserved: true,
    external_writes_reconciled: true,
    node_route_isolated_only: true,
    independent_work_continues: true,
    automatic_replay_requested: false,
  },
  continuity_route: {
    type: "approved_local_node_runtime",
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

run("healthy", structuredClone(base), 0, "windows_readonly_node_runtime_verified")

const broadAcl = structuredClone(base)
broadAcl.remediation.broad_temp_acl_requested = true
run("reject-broad-acl", broadAcl, 64, "broad_acl_or_permission_escalation_rejected")

const failure = structuredClone(base)
failure.runtime.kernel_staging_path = "C:/Users/host/AppData/Local/Temp/.tmp/kernel.js"
failure.runtime.staged_under_host_temp = true
failure.runtime.kernel_readable_by_sandbox = false
failure.runtime.module_not_found_observed = true
failure.runtime.minimal_node_canary_passed = false
failure.runtime.browser_canary_passed = false
failure.remediation.per_execution_sandbox_visible_directory = false
failure.remediation.cleanup_receipt = false
run("staging-failure", failure, 75, "sandbox_identity_cannot_read_host_temp_kernel")

const reset = structuredClone(failure)
reset.remediation.repeated_kernel_reset_requested = true
run("reject-resets", reset, 64, "repeated_kernel_reset_cannot_fix_staging_visibility")

const narrowNeedsCanary = structuredClone(failure)
narrowNeedsCanary.remediation.per_execution_sandbox_visible_directory = true
narrowNeedsCanary.remediation.cleanup_receipt = true
run("narrow-fix-canary", narrowNeedsCanary, 75, "narrow_staging_fix_requires_node_canary")

const browserCanary = structuredClone(base)
browserCanary.runtime.browser_canary_passed = false
run("browser-canary", browserCanary, 75, "browser_authority_requires_node_and_browser_canaries")

const packageIntegrity = structuredClone(base)
packageIntegrity.runtime.module_not_found_observed = true
packageIntegrity.runtime.package_hashes_verified = false
run("package-integrity", packageIntegrity, 75, "runtime_package_integrity_not_verified")

const replay = structuredClone(base)
replay.state.automatic_replay_requested = true
replay.state.external_writes_reconciled = false
run("reject-replay", replay, 64, "node_workflow_replay_rejected_before_reconciliation")

const noGlobalPause = structuredClone(failure)
noGlobalPause.remediation.per_execution_sandbox_visible_directory = true
noGlobalPause.remediation.cleanup_receipt = true
noGlobalPause.runtime.minimal_node_canary_passed = true
noGlobalPause.runtime.browser_canary_passed = true
noGlobalPause.state.node_route_isolated_only = false
noGlobalPause.state.independent_work_continues = false
run("avoid-global-pause", noGlobalPause, 75, "node_runtime_failure_must_not_pause_independent_work")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
