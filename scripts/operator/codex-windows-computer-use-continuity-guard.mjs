#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) parsed[key] = true
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-windows-computer-use-continuity-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read Windows Computer Use evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const routeReceipt = `${provider} ${route}`
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.test(routeReceipt)) blocked.push("prohibited_route_metadata")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
const platform = text(evidence.platform).toLowerCase()
const desktopBuild = text(evidence.desktop_build)
const helperRuntime = text(evidence.computer_use_runtime)
if (!taskId) blocked.push("task_id_missing")
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!platform) blocked.push("platform_missing")

const windows = platform.includes("windows")
const affectedBuild = desktopBuild === "26.721.4979.0"
const activeTurn = evidence.active_turn === true
const helperRunning = evidence.computer_use_process_running === true
const systemWideStutter = evidence.system_wide_stutter_observed === true
const controlledAbTestCompleted = evidence.controlled_ab_test_completed === true
const stutterAbsentAfterHelperStop = evidence.stutter_absent_after_helper_stop === true
const operationRequiresComputerUse = evidence.operation_requires_computer_use === true
const helperStopped = evidence.computer_use_helper_stopped === true
const exactHelperStopRequested = evidence.exact_helper_stop_requested === true
const helperPid = Number(evidence.computer_use_helper_pid || 0)
const helperPidBoundToOperation = evidence.helper_pid_bound_to_operation === true
const genericProcessKillRequested = evidence.generic_process_kill_requested === true
const canonicalTaskState = text(evidence.canonical_task_state).toLowerCase()
const uncertainWritesReconciled = evidence.uncertain_writes_reconciled === true
const alternateComputerUseExecutorVerified = evidence.alternate_computer_use_executor_verified === true
const desktopRetainedAsControlSurface = evidence.desktop_retained_as_control_surface === true
const rerouteTarget = text(evidence.reroute_target).toLowerCase()
const approvedReroute = new Set(["approved_linux_vps", "authorized_local_linux", "none"]).has(rerouteTarget || "none")
const canonicalStateValid = new Set(["active", "completed", "failed"]).has(canonicalTaskState)

if (!approvedReroute) blocked.push("unapproved_reroute_target")
if (genericProcessKillRequested) blocked.push("generic_process_kill_forbidden")
if (helperPid && (!Number.isInteger(helperPid) || helperPid < 1)) blocked.push("computer_use_helper_pid_invalid")

const stutterIncident = windows && affectedBuild && activeTurn && helperRunning && systemWideStutter
if (stutterIncident && !controlledAbTestCompleted) remediation.push("run_controlled_computer_use_helper_ab_test")
if (controlledAbTestCompleted && !stutterAbsentAfterHelperStop) remediation.push("verify_stutter_ceases_after_exact_helper_stop")
if (stutterIncident && (!helperPid || !helperPidBoundToOperation)) {
  remediation.push("bind_exact_computer_use_helper_pid_to_operation")
}
if (stutterIncident && !canonicalStateValid) blocked.push("canonical_task_state_required_before_containment")
if (stutterIncident && !uncertainWritesReconciled) blocked.push("uncertain_writes_must_be_reconciled_before_containment")

if (stutterIncident && !operationRequiresComputerUse) {
  if (!exactHelperStopRequested || !helperStopped) remediation.push("stop_only_exact_computer_use_helper")
  if (!desktopRetainedAsControlSurface) warnings.push("retain_desktop_as_control_and_audit_surface")
}

if (stutterIncident && operationRequiresComputerUse) {
  if (!alternateComputerUseExecutorVerified) {
    blocked.push("computer_use_operation_requires_verified_approved_alternate_executor")
  } else if (rerouteTarget === "none") {
    remediation.push("select_approved_computer_use_continuity_route")
  }
}

let incidentContained = false
if (stutterIncident && !operationRequiresComputerUse) {
  incidentContained =
    controlledAbTestCompleted &&
    stutterAbsentAfterHelperStop &&
    exactHelperStopRequested &&
    helperStopped &&
    helperPidBoundToOperation &&
    canonicalStateValid &&
    uncertainWritesReconciled
}
if (stutterIncident && operationRequiresComputerUse) {
  incidentContained = alternateComputerUseExecutorVerified && rerouteTarget !== "none" && canonicalStateValid && uncertainWritesReconciled
}

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: new Date().toISOString(),
  status,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  task_id: taskId || null,
  operation_id: operationId || null,
  platform: platform || null,
  desktop_build: desktopBuild || null,
  affected_build: affectedBuild,
  computer_use_runtime: helperRuntime || null,
  stutter_incident: stutterIncident,
  incident_contained: incidentContained,
  continuity_route:
    status === "compatible"
      ? stutterIncident
        ? "ordinary agent work continues after exact Computer Use helper isolation; Computer Use work uses only a verified approved alternate executor"
        : "current pinned direct OpenAI or approved-local route"
      : "preserve task and operation state; isolate only the exact Computer Use helper or reroute the Computer Use-specific operation through a verified approved executor",
  resume_condition:
    "Restore normal Computer Use helper authority only after the affected Windows build passes repeated active-turn canaries with no desktop-wide stutter, bounded UI Automation activity, correct helper idling or termination, and no task-state or external-write loss.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex Windows Computer Use boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
