#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"

function parseArgs(values) {
  const args = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = values[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function nonNegativeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

const prohibited = [
  "anthropic",
  "claude",
  "manus",
  "openrouter",
  "litellm",
  "bedrock",
  "vertex",
  "copilot-auto",
  "model-gateway",
]

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-marketplace-concurrency-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  const stat = fs.lstatSync(args.input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(args.input, "utf8"))
} catch (error) {
  console.error(`Unable to read marketplace evidence: ${error.message}`)
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
if (prohibited.some((name) => routeReceipt.includes(name))) blocked.push("prohibited_provider_or_gateway")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const operation = evidence.operation || {}
const operationId = text(operation.id)
const idempotencyKey = text(operation.idempotency_key)
const parallelExecProcesses = nonNegativeNumber(operation.parallel_exec_processes, 1)
if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!Number.isFinite(parallelExecProcesses) || parallelExecProcesses < 1) blocked.push("parallel_exec_process_count_invalid")

const marketplace = evidence.marketplace || {}
const sourceType = text(marketplace.source_type).toLowerCase()
const marketplaceId = text(marketplace.id)
const source = text(marketplace.source)
const ref = text(marketplace.ref)
const storedRevision = text(marketplace.stored_revision)
const remoteRevision = text(marketplace.remote_revision)
const gitMarketplace = sourceType === "git"
const lightweightRefCheckCompleted = marketplace.lightweight_ref_check_completed === true
const crossProcessLockHeld = marketplace.cross_process_lock_held === true
const unchangedRevisionReused = marketplace.unchanged_revision_reused === true
const refreshNeeded = marketplace.refresh_needed === true
const concurrentCloneProcesses = nonNegativeNumber(marketplace.concurrent_clone_processes)
const activeHttpsConnections = nonNegativeNumber(marketplace.active_https_connections)
const stagingDirectories = nonNegativeNumber(marketplace.staging_directories)
const stagingBytes = nonNegativeNumber(marketplace.staging_bytes)
const orphanCloneProcesses = nonNegativeNumber(marketplace.orphan_clone_processes)
const orphanProcessesInventoried = marketplace.orphan_processes_inventoried === true
const cleanupScopedToVerifiedPids = marketplace.cleanup_scoped_to_verified_pids === true
const bulkProcessKillRequested = marketplace.bulk_process_kill_requested === true

if (!marketplaceId) blocked.push("marketplace_id_missing")
if (!sourceType) blocked.push("marketplace_source_type_missing")
if (gitMarketplace && !source) blocked.push("git_marketplace_source_missing")
if (gitMarketplace && !ref) blocked.push("git_marketplace_ref_missing")
for (const [name, value] of [
  ["concurrent_clone_processes", concurrentCloneProcesses],
  ["active_https_connections", activeHttpsConnections],
  ["staging_directories", stagingDirectories],
  ["staging_bytes", stagingBytes],
  ["orphan_clone_processes", orphanCloneProcesses],
]) {
  if (!Number.isFinite(value)) blocked.push(`${name}_invalid`)
}
if (bulkProcessKillRequested) blocked.push("bulk_process_kill_forbidden")

const unchangedRevision = Boolean(storedRevision && remoteRevision && storedRevision === remoteRevision)
const cloneFanout = gitMarketplace && concurrentCloneProcesses > 1
const stagingPressure = gitMarketplace && (stagingBytes >= 1_073_741_824 || stagingDirectories > 4)
const highConnectionFanout = gitMarketplace && activeHttpsConnections > 8
const concurrencyRisk = gitMarketplace && parallelExecProcesses > 1

if (gitMarketplace && !lightweightRefCheckCompleted) remediation.push("perform_lightweight_remote_ref_check")
if (concurrencyRisk && !crossProcessLockHeld) remediation.push("acquire_per_marketplace_cross_process_lock")
if (unchangedRevision && !unchangedRevisionReused) remediation.push("reuse_existing_marketplace_materialization")
if (refreshNeeded && !crossProcessLockHeld) remediation.push("single_flight_marketplace_refresh_required")
if (cloneFanout) blocked.push("duplicate_marketplace_clone_fanout_detected")
if (stagingPressure) blocked.push("marketplace_staging_resource_pressure_detected")
if (highConnectionFanout) blocked.push("marketplace_https_connection_fanout_detected")
if (orphanCloneProcesses > 0 && !orphanProcessesInventoried) blocked.push("orphan_clone_process_inventory_required")
if (orphanCloneProcesses > 0 && !cleanupScopedToVerifiedPids) blocked.push("orphan_clone_cleanup_must_be_pid_scoped")

const containment = evidence.containment || {}
const newExecLaunchesSuspended = containment.new_exec_launches_suspended === true
const marketplaceRefreshIsolated = containment.marketplace_refresh_isolated === true
const pinnedMaterializationVerified = containment.pinned_materialization_verified === true
const unaffectedWorkflowsContinued = containment.unaffected_workflows_continued === true

if ((cloneFanout || stagingPressure || highConnectionFanout) && !newExecLaunchesSuspended) {
  remediation.push("suspend_new_parallel_codex_exec_launches")
}
if ((cloneFanout || stagingPressure || highConnectionFanout) && !marketplaceRefreshIsolated) {
  remediation.push("isolate_git_marketplace_refresh_path")
}
if (marketplaceRefreshIsolated && !pinnedMaterializationVerified) {
  remediation.push("verify_pinned_local_marketplace_materialization")
}
if ((cloneFanout || stagingPressure || highConnectionFanout) && !unaffectedWorkflowsContinued) {
  warnings.push("continue_unaffected_workflows_through_approved_route")
}

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: new Date().toISOString(),
  status,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  marketplace: {
    id: marketplaceId || null,
    source_type: sourceType || null,
    source: source || null,
    ref: ref || null,
    stored_revision: storedRevision || null,
    remote_revision: remoteRevision || null,
    unchanged_revision: unchangedRevision,
    clone_fanout: cloneFanout,
    staging_pressure: stagingPressure,
    high_connection_fanout: highConnectionFanout,
  },
  continuity_route:
    status === "compatible"
      ? "current pinned direct OpenAI or approved-local route"
      : "preserve task state; serialize or isolate Git marketplace refresh; continue unaffected work through pinned direct OpenAI or explicitly authorized local execution",
  resume_condition:
    "Resume parallel codex exec admission only after one lightweight ref check, one verified marketplace materialization, a per-marketplace cross-process lock, zero orphan clone processes, and bounded staging and HTTPS fanout are proven.",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex marketplace concurrency boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
