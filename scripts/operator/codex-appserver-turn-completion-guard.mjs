import fs from "node:fs"
import path from "node:path"
import { nowIso, parseArgs, sha256, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const inputFile = args.input
if (typeof inputFile !== "string" || !path.isAbsolute(inputFile)) {
  console.error("Usage: bun scripts/operator/codex-appserver-turn-completion-guard.mjs --input /absolute/snapshot.json [--json]")
  process.exit(2)
}

let snapshot
try {
  snapshot = JSON.parse(fs.readFileSync(inputFile, "utf8"))
} catch (error) {
  console.error(`Unable to read completion snapshot: ${error.message}`)
  process.exit(2)
}

function boolean(name) {
  if (typeof snapshot[name] !== "boolean") throw new Error(`${name} must be boolean`)
  return snapshot[name]
}

function count(name) {
  const value = snapshot[name]
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function seconds(name) {
  const value = snapshot[name]
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

let state
try {
  if (snapshot.schema_version !== 1) throw new Error("schema_version must equal 1")
  if (typeof snapshot.turn_id !== "string" || snapshot.turn_id.trim() === "") throw new Error("turn_id is required")

  state = {
    turn_completed_seen: boolean("turn_completed_seen"),
    final_assistant_output_seen: boolean("final_assistant_output_seen"),
    artifact_required: boolean("artifact_required"),
    artifact_verified: boolean("artifact_verified"),
    external_write_attempted: boolean("external_write_attempted"),
    destination_verified: boolean("destination_verified"),
    tool_requests_total: count("tool_requests_total"),
    tool_results_accepted: count("tool_results_accepted"),
    outstanding_tool_requests: count("outstanding_tool_requests"),
    outstanding_server_requests: count("outstanding_server_requests"),
    outstanding_approvals: count("outstanding_approvals"),
    outstanding_protocol_items: count("outstanding_protocol_items"),
    outstanding_subagents: count("outstanding_subagents"),
    owned_background_processes: count("owned_background_processes"),
    seconds_since_last_event: seconds("seconds_since_last_event"),
  }
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const minimumQuietSeconds = Number(args["minimum-quiet-seconds"] || process.env.OPERATOR_APP_SERVER_TERMINAL_QUIET_SECONDS || 5)
if (!Number.isFinite(minimumQuietSeconds) || minimumQuietSeconds < 0) {
  console.error("minimum quiet seconds must be a non-negative number")
  process.exit(2)
}

const obligations =
  state.outstanding_tool_requests +
  state.outstanding_server_requests +
  state.outstanding_approvals +
  state.outstanding_protocol_items +
  state.outstanding_subagents +
  state.owned_background_processes
const toolResultsMatched = state.tool_requests_total === state.tool_results_accepted
const artifactSatisfied = !state.artifact_required || state.artifact_verified
const writeSatisfied = !state.external_write_attempted || state.destination_verified
const semanticallySettled =
  state.final_assistant_output_seen &&
  toolResultsMatched &&
  obligations === 0 &&
  artifactSatisfied &&
  state.seconds_since_last_event >= minimumQuietSeconds

let status
let safeToContinue
let syntheticCompletion
let requiresReconciliation

if (state.turn_completed_seen) {
  status = "protocol_complete"
  safeToContinue = true
  syntheticCompletion = false
  requiresReconciliation = false
} else if (semanticallySettled && writeSatisfied) {
  status = "verified_completion_without_terminal_event"
  safeToContinue = true
  syntheticCompletion = true
  requiresReconciliation = false
} else if (state.external_write_attempted && !state.destination_verified) {
  status = "write_reconciliation_required"
  safeToContinue = false
  syntheticCompletion = false
  requiresReconciliation = true
} else {
  status = "terminal_state_not_proven"
  safeToContinue = false
  syntheticCompletion = false
  requiresReconciliation = false
}

const report = {
  schema_version: 1,
  observed_at: nowIso(),
  turn_id: snapshot.turn_id,
  status,
  safe_to_continue: safeToContinue,
  synthetic_local_completion: syntheticCompletion,
  requires_destination_reconciliation: requiresReconciliation,
  automatic_retry_allowed: false,
  minimum_quiet_seconds: minimumQuietSeconds,
  checks: {
    final_assistant_output_seen: state.final_assistant_output_seen,
    tool_results_matched: toolResultsMatched,
    outstanding_obligations: obligations,
    artifact_satisfied: artifactSatisfied,
    external_write_satisfied: writeSatisfied,
    quiet_period_satisfied: state.seconds_since_last_event >= minimumQuietSeconds,
  },
  snapshot_sha256: sha256(JSON.stringify(snapshot)),
  remediation:
    status === "write_reconciliation_required"
      ? "Read the destination using the original operation identifier before any replay."
      : status === "terminal_state_not_proven"
        ? "Keep the turn bounded and collect another snapshot; do not create a replacement turn or retry external work."
        : null,
}

const directory = path.resolve(args["evidence-dir"] || path.join(stateRoot(args), "appserver-turn-completion"))
const evidenceFile = path.join(directory, `${report.observed_at.replace(/[:.]/g, "-")}-${snapshot.turn_id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`)
writeJsonAtomic(evidenceFile, report)

const result = { ...report, evidence_file: evidenceFile }
if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex app-server turn ${snapshot.turn_id}: ${status}`)
  console.log(`Evidence: ${evidenceFile}`)
  if (!safeToContinue) console.error(report.remediation || "Completion is not proven")
}

process.exit(safeToContinue ? 0 : 75)
