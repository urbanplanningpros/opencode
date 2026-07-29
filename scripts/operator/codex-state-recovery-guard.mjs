import crypto from "node:crypto"
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
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function emit(report, code, jsonMode) {
  const output = JSON.stringify(report, null, 2)
  if (code === 0 || jsonMode) console.log(output)
  else console.error(output)
  process.exit(code)
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node codex-state-recovery-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  emit({ admitted: false, reason: "invalid_input", detail: error.message }, 2, args.json)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const routingMetadata = JSON.stringify({
  provider: evidence.provider,
  route: evidence.route,
  gateway: evidence.gateway,
  fallback: evidence.fallback,
  imported_from: evidence.imported_from,
})
if (prohibited.test(routingMetadata)) {
  emit({ admitted: false, reason: "prohibited_route_metadata" }, 64, args.json)
}

const mode = String(evidence.mode || "")
if (!evidence.operation_id || !evidence.idempotency_key) {
  emit(
    {
      admitted: false,
      reason: "missing_operation_identity",
      missing: ["operation_id", "idempotency_key"].filter((key) => !evidence[key]),
    },
    2,
    args.json,
  )
}

if (mode === "security_scan_finalization") {
  const artifacts = Array.isArray(evidence.canonical_artifacts) ? evidence.canonical_artifacts : []
  if (artifacts.length === 0) {
    emit({ admitted: false, reason: "canonical_artifacts_required" }, 2, args.json)
  }

  const artifactResults = []
  try {
    for (const artifact of artifacts) {
      const artifactPath = path.resolve(String(artifact.path || ""))
      const stat = fs.lstatSync(artifactPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${artifactPath} is not a regular file`)
      const actualSha256 = hashFile(artifactPath)
      const expectedSha256 = String(artifact.sha256 || "").toLowerCase()
      artifactResults.push({ path: artifactPath, expected_sha256: expectedSha256, actual_sha256: actualSha256 })
      if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256) {
        emit(
          {
            admitted: false,
            reason: "artifact_integrity_failure",
            operation_id: evidence.operation_id,
            artifact: artifactPath,
            expected_sha256: expectedSha256,
            actual_sha256: actualSha256,
            protocol: "Preserve the bundle and investigate the mismatch. Do not finalize or repeat discovery.",
          },
          64,
          args.json,
        )
      }
    }
  } catch (error) {
    emit(
      {
        admitted: false,
        reason: "artifact_read_failure",
        detail: error.message,
        protocol: "Preserve all available scan state. Do not start a replacement scan until artifact provenance is reconciled.",
      },
      64,
      args.json,
    )
  }

  const phasesComplete =
    evidence.discovery_complete === true &&
    evidence.validation_complete === true &&
    evidence.writeups_complete === true &&
    evidence.artifacts_complete === true
  if (!phasesComplete) {
    emit(
      {
        admitted: false,
        reason: "scan_work_incomplete",
        operation_id: evidence.operation_id,
        protocol: "Resume only the incomplete phase from the persisted manifest. Do not restart completed phases.",
      },
      75,
      args.json,
    )
  }

  const expectedSnapshot = String(evidence.expected_snapshot_sha256 || "").toLowerCase()
  const currentSnapshot = String(evidence.current_snapshot_sha256 || "").toLowerCase()
  const snapshotMatches = /^[a-f0-9]{64}$/.test(expectedSnapshot) && expectedSnapshot === currentSnapshot
  const ownerValid = evidence.continuation_owner_valid === true

  if (snapshotMatches && ownerValid) {
    emit(
      {
        admitted: true,
        reason: "existing_scan_artifacts_ready_to_finalize",
        operation_id: evidence.operation_id,
        action: "finalize_existing_artifacts_once",
        artifact_count: artifactResults.length,
        protocol:
          "Finalize the existing canonical bundle exactly once with the original operation ID and idempotency key, then verify the sealed report. Do not rerun discovery, validation, or write-up generation.",
      },
      0,
      args.json,
    )
  }

  emit(
    {
      admitted: false,
      reason: "recoverable_finalization_state_mismatch",
      operation_id: evidence.operation_id,
      snapshot_matches: snapshotMatches,
      continuation_owner_valid: ownerValid,
      action: snapshotMatches ? "reclaim_continuation_then_finalize" : "restore_or_rebind_snapshot_then_adopt_artifacts",
      artifact_count: artifactResults.length,
      protocol:
        "Preserve the validated artifact bundle and original handoff evidence. Reclaim the original continuation owner and restore or rebind the exact target snapshot. Finalize or adopt the existing artifacts; do not launch another Deep scan.",
    },
    75,
    args.json,
  )
}

if (mode === "compaction_capacity") {
  const errorText = String(evidence.error || "")
  const capacityFailure = /remote compact task|selected model is at capacity|capacity/i.test(errorText)
  if (!capacityFailure) {
    emit(
      {
        admitted: true,
        reason: "no_compaction_capacity_failure",
        operation_id: evidence.operation_id,
        action: "continue_current_task",
      },
      0,
      args.json,
    )
  }

  if (!evidence.selected_model || evidence.allow_automatic_model_change === true) {
    emit(
      {
        admitted: false,
        reason: evidence.selected_model ? "automatic_model_change_forbidden" : "selected_model_required",
        protocol: "Keep the explicitly selected approved OpenAI model. Do not invoke an automatic selector or gateway.",
      },
      evidence.selected_model ? 64 : 2,
      args.json,
    )
  }

  if (evidence.task_state_checkpointed !== true || evidence.pending_writes_reconciled !== true) {
    emit(
      {
        admitted: false,
        reason: "state_checkpoint_and_write_reconciliation_required",
        operation_id: evidence.operation_id,
        action: "checkpoint_before_retry",
        protocol:
          "Persist the task manifest, context summary, tool state, operation ID, and idempotency key. Reconcile every uncertain external write before retrying compaction or continuing in a fresh turn.",
      },
      75,
      args.json,
    )
  }

  const failureCount = Number.parseInt(String(evidence.failure_count || "1"), 10)
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    emit({ admitted: false, reason: "invalid_failure_count" }, 2, args.json)
  }

  const firstFailure = failureCount === 1
  emit(
    {
      admitted: false,
      reason: "transient_compaction_capacity_failure",
      operation_id: evidence.operation_id,
      selected_model: evidence.selected_model,
      failure_count: failureCount,
      action: firstFailure ? "retry_same_model_once_after_jitter" : "resume_fresh_guarded_turn_from_checkpoint",
      protocol: firstFailure
        ? "Retry the same approved model once after bounded jitter while preserving the current task state. Do not change models automatically."
        : "Stop repeating remote compaction. Start a fresh guarded turn from the persisted checkpoint or use the explicitly authorized local continuity route, preserving lineage and reconciling writes before continuation.",
    },
    75,
    args.json,
  )
}

emit({ admitted: false, reason: "unsupported_mode", mode }, 2, args.json)
