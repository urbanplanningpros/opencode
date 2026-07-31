import fs from "node:fs"
import path from "node:path"

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) { out[key] = next; i += 1 } else out[key] = true
  }
  return out
}

function emit(ok, reason, action, operationId, code) {
  ;(ok ? process.stdout : process.stderr).write(`${JSON.stringify({ admitted: ok, reason, action, operation_id: operationId }, null, 2)}\n`)
  process.exit(code)
}

const options = args(process.argv.slice(2))
if (!options.input) emit(false, "missing_input", "provide_evidence_json", "", 2)

let evidence
try {
  const file = path.resolve(String(options.input))
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular file")
  evidence = JSON.parse(fs.readFileSync(file, "utf8"))
} catch (error) {
  emit(false, "invalid_evidence", error.message, "", 2)
}

const operationId = String(evidence.operation_id || "").trim()
const goal = evidence.goal || {}
const state = evidence.state || {}
if (!operationId) emit(false, "missing_operation_id", "bind_the_goal_to_an_operation", "", 2)

const elapsedLimitReached = Number(goal.elapsed_seconds || 0) >= Number(goal.checkpoint_seconds || Number.MAX_SAFE_INTEGER)
const tokenLimitReached = Number(goal.tokens_used || 0) >= Number(goal.token_limit || Number.MAX_SAFE_INTEGER)
const repeatedLoop = Number(goal.repeated_loop_count || 0) >= 3 && Number(goal.progress_delta || 0) === 0
const compactionLoop = Number(goal.compaction_count || 0) >= 2 && repeatedLoop
const checkpointNeeded = elapsedLimitReached || tokenLimitReached || compactionLoop

if ((state.replay_requested === true || state.replacement_goal_requested === true) && (state.task_state_preserved !== true || state.external_writes_reconciled !== true)) {
  emit(false, "replay_rejected_before_reconciliation", "preserve_the_current_goal_and_reconcile_prior_changes", operationId, 64)
}
if (state.broad_pause_requested === true) {
  emit(false, "broad_pause_rejected", "checkpoint_only_the_affected_goal_and_continue_independent_work", operationId, 64)
}
if (checkpointNeeded && goal.checkpoint_written !== true) {
  emit(false, "checkpoint_required", "record_acceptance_status_changed_files_tests_results_and_the_next_narrow_probe", operationId, 75)
}
if (repeatedLoop && goal.narrow_probe_defined !== true) {
  emit(false, "narrow_probe_required", "stop_only_the_repeated_loop_and_define_one_reproducible_probe", operationId, 75)
}
if ((elapsedLimitReached || tokenLimitReached) && goal.extension_authorized !== true) {
  emit(false, "extension_required", "continue_only_after_a_bounded_extension_or_verified_narrow_probe", operationId, 77)
}
if (state.task_state_preserved !== true || state.external_writes_reconciled !== true) {
  emit(false, "state_reconciliation_required", "reconcile_state_and_durable_changes_before_the_next_iteration", operationId, 75)
}

emit(true, "goal_checkpoint_policy_satisfied", "continue_with_the_current_goal", operationId, 0)
