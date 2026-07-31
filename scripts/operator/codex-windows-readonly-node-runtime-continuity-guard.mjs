import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular non-symlink file`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function object(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|model[-_ ]?gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set([
  "direct_openai_cli",
  "direct_openai_api",
  "direct_openai_app_server",
  "approved_local_node_runtime",
  "approved_local_browser_runtime",
  "approved_linux_openai",
])

if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (prohibited.test(JSON.stringify(evidence))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let runtime
let remediation
let state
let continuity

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  runtime = object(evidence.runtime, "runtime")
  remediation = object(evidence.remediation, "remediation")
  state = object(evidence.state, "state")
  continuity = object(evidence.continuity_route, "continuity_route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const platform = nonEmptyString(runtime.platform, "runtime.platform").toLowerCase()
const permissionMode = nonEmptyString(runtime.permission_mode, "runtime.permission_mode").toLowerCase()
const nodeReplExposed = boolean(runtime.node_repl_exposed, "runtime.node_repl_exposed")
const browserDependsOnNode = boolean(runtime.browser_depends_on_node, "runtime.browser_depends_on_node")
const stagingPath = optionalString(runtime.kernel_staging_path, "runtime.kernel_staging_path")
const stagedUnderHostTemp = boolean(runtime.staged_under_host_temp, "runtime.staged_under_host_temp")
const sandboxIdentity = optionalString(runtime.sandbox_identity, "runtime.sandbox_identity")
const kernelReadableBySandbox = boolean(runtime.kernel_readable_by_sandbox, "runtime.kernel_readable_by_sandbox")
const moduleNotFoundObserved = boolean(runtime.module_not_found_observed, "runtime.module_not_found_observed")
const packageHashesVerified = boolean(runtime.package_hashes_verified, "runtime.package_hashes_verified")
const minimalNodeCanaryPassed = boolean(runtime.minimal_node_canary_passed, "runtime.minimal_node_canary_passed")
const browserCanaryPassed = boolean(runtime.browser_canary_passed, "runtime.browser_canary_passed")

const perExecutionDirectory = boolean(remediation.per_execution_sandbox_visible_directory, "remediation.per_execution_sandbox_visible_directory")
const narrowReadExecuteGrant = boolean(remediation.narrow_read_execute_grant, "remediation.narrow_read_execute_grant")
const grantBoundToExactDirectory = boolean(remediation.grant_bound_to_exact_directory, "remediation.grant_bound_to_exact_directory")
const cleanupReceipt = boolean(remediation.cleanup_receipt, "remediation.cleanup_receipt")
const broadTempAclRequested = boolean(remediation.broad_temp_acl_requested, "remediation.broad_temp_acl_requested")
const fullAccessEscalationRequested = boolean(remediation.full_access_escalation_requested, "remediation.full_access_escalation_requested")
const repeatedKernelResetRequested = boolean(remediation.repeated_kernel_reset_requested, "remediation.repeated_kernel_reset_requested")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const nodeRouteIsolatedOnly = boolean(state.node_route_isolated_only, "state.node_route_isolated_only")
const independentWorkContinues = boolean(state.independent_work_continues, "state.independent_work_continues")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")

const routeType = optionalString(continuity.type, "continuity_route.type").toLowerCase()
const routeVerified = boolean(continuity.verified, "continuity_route.verified")
const routeCanaryPassed = boolean(continuity.canary_passed, "continuity_route.canary_passed")
const operationBindingMatches = boolean(continuity.operation_binding_matches, "continuity_route.operation_binding_matches")
const routeReady = approvedRoutes.has(routeType) && routeVerified && routeCanaryPassed && operationBindingMatches

const affectedRuntime = platform === "windows" && permissionMode === "read-only" && nodeReplExposed
const stagingVisibilityFailure = affectedRuntime && stagedUnderHostTemp && (!kernelReadableBySandbox || moduleNotFoundObserved)
const narrowFixReady = perExecutionDirectory || (narrowReadExecuteGrant && grantBoundToExactDirectory && cleanupReceipt)
const nodeReady = !affectedRuntime || (kernelReadableBySandbox && minimalNodeCanaryPassed)
const browserReady = !browserDependsOnNode || (nodeReady && browserCanaryPassed)
const preservationReady = taskStatePreserved && externalWritesReconciled

let admitted = true
let reason = "windows_readonly_node_runtime_verified"
let action = "continue_node_and_browser_workflow"
let exitCode = 0

if (broadTempAclRequested || fullAccessEscalationRequested) {
  admitted = false
  reason = "broad_acl_or_permission_escalation_rejected"
  action = "use_per_execution_staging_or_exact_directory_read_execute_grant"
  exitCode = 64
} else if (repeatedKernelResetRequested && stagingVisibilityFailure) {
  admitted = false
  reason = "repeated_kernel_reset_cannot_fix_staging_visibility"
  action = "suppress_identical_resets_and_change_the_staging_boundary"
  exitCode = 64
} else if (stagingVisibilityFailure && !narrowFixReady) {
  admitted = false
  reason = "sandbox_identity_cannot_read_host_temp_kernel"
  action = routeReady && preservationReady
    ? "isolate_node_backed_route_and_continue_exact_operation_through_verified_runtime"
    : "preserve_state_then_stage_kernel_in_sandbox_visible_execution_directory"
  exitCode = 75
} else if (stagingVisibilityFailure && narrowFixReady && !minimalNodeCanaryPassed) {
  admitted = false
  reason = "narrow_staging_fix_requires_node_canary"
  action = "run_minimal_node_repl_canary_before_restoring_node_authority"
  exitCode = 75
} else if (browserDependsOnNode && !browserReady) {
  admitted = false
  reason = "browser_authority_requires_node_and_browser_canaries"
  action = routeReady && preservationReady
    ? "continue_browser_step_through_verified_operation_bound_runtime"
    : "withhold_only_browser_step_until_canaries_pass"
  exitCode = 75
} else if (!packageHashesVerified && moduleNotFoundObserved) {
  admitted = false
  reason = "runtime_package_integrity_not_verified"
  action = "verify_official_package_hashes_before_changing_permissions_or_reinstalling"
  exitCode = 75
} else if (automaticReplayRequested && !preservationReady) {
  admitted = false
  reason = "node_workflow_replay_rejected_before_reconciliation"
  action = "reconcile_repository_connector_and_deployment_writes"
  exitCode = 64
} else if (stagingVisibilityFailure && (!nodeRouteIsolatedOnly || !independentWorkContinues)) {
  admitted = false
  reason = "node_runtime_failure_must_not_pause_independent_work"
  action = "isolate_only_node_and_browser_dependent_steps"
  exitCode = 75
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  affected_runtime: affectedRuntime,
  staging_path_present: stagingPath !== "",
  sandbox_identity_present: sandboxIdentity !== "",
  staging_visibility_failure: stagingVisibilityFailure,
  narrow_fix_ready: narrowFixReady,
  node_ready: nodeReady,
  browser_ready: browserReady,
  continuity_route_ready: routeReady,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
