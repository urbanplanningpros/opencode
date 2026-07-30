import fs from "node:fs"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, x) => {
  if (v.startsWith("--")) a.push([v.slice(2), x[i + 1] && !x[i + 1].startsWith("--") ? x[i + 1] : true])
  return a
}, []))
const deny = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const fail = (reason, code = 2, detail) => {
  console.error(JSON.stringify({ admitted: false, reason, ...(detail ? { detail } : {}) }, null, 2))
  process.exit(code)
}
if (!args.input) fail("missing_input")
let e
try {
  const p = path.resolve(String(args.input)); const s = fs.lstatSync(p)
  if (!s.isFile() || s.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  e = JSON.parse(fs.readFileSync(p, "utf8"))
} catch (error) { fail("invalid_evidence", 2, error.message) }
if (deny.test(JSON.stringify({ e, provider: args.provider || process.env.OPERATOR_PROVIDER, route: args.route || process.env.OPERATOR_ROUTE, gateway: process.env.OPERATOR_GATEWAY }))) fail("prohibited_route_metadata", 64)
const str = (v, n, required = false) => {
  if (v == null || v === "") { if (required) throw new Error(`${n} is required`); return "" }
  if (typeof v !== "string") throw new Error(`${n} must be a string`)
  return v.trim()
}
const num = (v, n) => { if (v == null) return 0; if (!Number.isFinite(v)) throw new Error(`${n} must be finite`); return v }
const bool = (v, n) => { if (v == null) return false; if (typeof v !== "boolean") throw new Error(`${n} must be boolean`); return v }
const arr = (v, n) => { if (v == null) return []; if (!Array.isArray(v)) throw new Error(`${n} must be an array`); return v }
let taskId, operationId, s, m
try {
  taskId = str(e.task_id, "task_id", true); operationId = str(e.operation_id, "operation_id", true)
  s = e.session_rollout || {}; m = e.multi_agent_residency || {}
  if (typeof s !== "object" || Array.isArray(s) || typeof m !== "object" || Array.isArray(m)) throw new Error("evidence sections must be objects")
} catch (error) { fail("malformed_evidence", 2, error.message) }
let rollouts
try {
  rollouts = arr(s.rollouts, "session_rollout.rollouts").map((r, i) => ({
    rollout_id: str(r.rollout_id, `rollouts[${i}].rollout_id`, true), session_id: str(r.session_id, `rollouts[${i}].session_id`, true),
    source: str(r.thread_source, `rollouts[${i}].thread_source`).toLowerCase(), parent: str(r.parent_thread_id, `rollouts[${i}].parent_thread_id`),
    initial: num(r.initial_last_input_tokens, `rollouts[${i}].initial`), latest: num(r.latest_last_input_tokens, `rollouts[${i}].latest`),
    events: num(r.token_count_events, `rollouts[${i}].events`), raw: num(r.maximum_raw_tool_output_bytes, `rollouts[${i}].raw`),
  }))
} catch (error) { fail("malformed_rollout_evidence", 2, error.message) }
const uniq = (x) => [...new Set(x)]
const sameRoot = rollouts.length >= 2 && uniq(rollouts.map(r => r.session_id)).length === 1 && uniq(rollouts.map(r => r.initial)).length === 1 && rollouts.every(r => r.source === "user" && !r.parent)
const baseline = rollouts[0]?.initial || 0, maximum = Math.max(0, ...rollouts.map(r => r.latest)), growth = baseline ? maximum / baseline : 0
const replay = sameRoot && rollouts.some(r => r.events >= 100) && (maximum >= 50000 || growth >= 2)
const rawPressure = rollouts.some(r => r.raw >= 262144), rolloutAnomaly = replay || rawPressure
let rolloutRoute, rolloutRecovery
try {
  rolloutRoute = str(s.continuation_route, "session_rollout.continuation_route").toLowerCase()
  rolloutRecovery = !rolloutAnomaly || (bool(s.canonical_thread_state_reconciled, "canonical_thread_state_reconciled") && bool(s.external_writes_reconciled, "external_writes_reconciled") && bool(s.compact_checkpoint_exported, "compact_checkpoint_exported") && bool(s.duplicate_rollout_creation_blocked, "duplicate_rollout_creation_blocked") && new Set(["same_thread_fresh_projection", "approved_local", "approved_linux"]).has(rolloutRoute))
} catch (error) { fail("malformed_rollout_recovery", 2, error.message) }
let residents, manager, claims, max, residencyRoute
try {
  residents = uniq(arr(m.resident_thread_ids, "resident_thread_ids").map((v, i) => str(v, `resident_thread_ids[${i}]`, true)))
  manager = uniq(arr(m.manager_thread_ids, "manager_thread_ids").map((v, i) => str(v, `manager_thread_ids[${i}]`, true)))
  claims = uniq(arr(m.eviction_claim_thread_ids, "eviction_claim_thread_ids").map((v, i) => str(v, `eviction_claim_thread_ids[${i}]`, true)))
  max = num(m.max_resident_threads, "max_resident_threads"); residencyRoute = str(m.continuation_route, "multi_agent_residency.continuation_route").toLowerCase()
} catch (error) { fail("malformed_residency_evidence", 2, error.message) }
const staleResidents = residents.filter(id => !manager.includes(id)), staleClaims = claims.filter(id => !manager.includes(id))
const falseCapacity = bool(m.enabled, "multi_agent_residency.enabled") && bool(m.agent_limit_reached, "agent_limit_reached") && bool(m.immediate_retry_succeeded, "immediate_retry_succeeded") && (bool(m.followup_during_eviction, "followup_during_eviction") || (max > 0 && manager.length < max))
const residencyAnomaly = bool(m.enabled, "multi_agent_residency.enabled") && (falseCapacity || staleResidents.length || staleClaims.length)
const unsafeRetry = residencyAnomaly && (bool(m.automatic_retry_attempted, "automatic_retry_attempted") || bool(m.automatic_respawn_attempted, "automatic_respawn_attempted"))
const residencyRecovery = !residencyAnomaly || (bool(m.exact_runtime_reconciled, "exact_runtime_reconciled") && bool(m.accepted_work_reconciled, "accepted_work_reconciled") && bool(m.operation_state_reconciled, "operation_state_reconciled") && new Set(["guarded_single_agent", "approved_local", "approved_linux"]).has(residencyRoute))
let admitted = true, reason = "session_and_residency_continuity_verified", code = 0
if (unsafeRetry) { admitted = false; reason = "multi_agent_residency_automatic_retry_forbidden"; code = 64 }
else if (!rolloutRecovery) { admitted = false; reason = "unexpected_session_rollout_replay_detected"; code = 75 }
else if (!residencyRecovery) { admitted = false; reason = "multi_agent_residency_state_unreconciled"; code = 75 }
const report = { admitted, reason, task_id: taskId, operation_id: operationId,
  session_rollout: { rollout_count: rollouts.length, duplicate_user_root_rollouts: sameRoot, repeated_history_materialization: replay, raw_history_pressure: rawPressure, anomaly_detected: rolloutAnomaly, baseline_input_tokens: baseline, maximum_latest_input_tokens: maximum, context_growth_ratio: Number(growth.toFixed(2)), continuation_route: rolloutRoute || null },
  multi_agent_residency: { enabled: !!m.enabled, stale_resident_thread_ids: staleResidents, stale_eviction_claim_thread_ids: staleClaims, false_capacity_signature: falseCapacity, anomaly_detected: !!residencyAnomaly, continuation_route: residencyRoute || null },
  protocol: admitted ? "Continue only the exact unfinished action. Block duplicate rollouts; preserve canonical state; use a fresh same-thread projection, guarded single-agent execution, or approved local/Linux execution after reconciliation." : "Stop only the affected rollout or MultiAgentV2 admission path. Preserve thread, rollout, runtime, operation, idempotency, repository, and external-write receipts. Do not replay or respawn automatically.",
  resume_condition: "Resume after canonical thread and external writes are reconciled and duplicate rollout creation is blocked, or after exact runtime, accepted work, and residency state are reconciled."
}
console.log(JSON.stringify(report, null, 2)); process.exit(code)
