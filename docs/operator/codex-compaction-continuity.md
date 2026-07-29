# Codex compaction continuity boundary

## Scope

Upstream `openai/codex#35935` reports a Windows Codex Desktop long-running task repeatedly returning to earlier analysis and implementation stages after automatic context compaction. The reported loop consumed the user's remaining weekly allowance without producing the final result. Subagent findings and completed work appeared to weaken or disappear after compaction.

This boundary does not pause the full operator stack. It stops only a turn whose restored state cannot be proven, then continues from a provider-neutral external checkpoint through the pinned direct OpenAI route or an explicitly authorized local route.

## Required checkpoint

Before a long task approaches compaction, persist outside model memory:

- immutable task and completion-criteria hashes;
- checkpoint ID and exact current phase;
- repository commit SHA and current diff SHA-256;
- canonical completed-step ledger and its SHA-256;
- remaining-step ledger;
- completed command, build, and test receipts;
- completed subagent task IDs and findings when subagents are enabled;
- exact next action and completion condition;
- operation IDs, idempotency keys, and uncertain-write reconciliation state.

## Guard

```bash
node scripts/operator/codex-compaction-continuity-guard.mjs \
  --input /approved/task/compaction-continuity.json \
  --json
```

Example evidence:

```json
{
  "task_id": "task-20260729-001",
  "completion_criteria_sha256": "criteria-sha256",
  "checkpoint_id": "checkpoint-4",
  "repository_sha": "repo-sha",
  "diff_sha256": "diff-sha256",
  "completed_steps_sha256": "completed-sha256",
  "phase": "verification",
  "next_action": "run final bounded test",
  "completed_steps": ["inspect repository", "apply patch", "build application"],
  "remaining_steps": ["run final bounded test", "publish completion report"],
  "compaction_count": 1,
  "repeated_command_count": 0,
  "repeated_build_without_diff_count": 0,
  "reopened_resolved_count": 0,
  "duplicate_subagent_assignment_count": 0,
  "completed_step_regression_count": 0,
  "checkpoint_restored": true,
  "repository_state_verified": true,
  "uncertain_writes_reconciled": true,
  "subagents_enabled": false,
  "subagent_results_restored": false,
  "restored_completion_criteria_sha256": "criteria-sha256",
  "restored_completed_steps_sha256": "completed-sha256",
  "restored_next_action": "run final bounded test",
  "fresh_guarded_turn": false,
  "continuation_state_persisted": true
}
```

Exit behavior:

```text
0   exact checkpoint continuity verified
75  stop the regressing turn and continue from a fresh guarded checkpoint
64  prohibited provider, gateway, or automatic-selection metadata
2   malformed evidence
```

## Recovery route

When the guard exits `75`:

1. Stop only the regressing turn. Do not allow it to create more tasks, subagents, builds, reviews, or writes.
2. Persist the exact repository state, diff, completed-step ledger, subagent findings, and next action outside model memory.
3. Reconcile every uncertain external write before replay.
4. Start a fresh guarded single-agent turn with the same immutable completion criteria.
5. Verify the repository and destination state before executing the exact next action.
6. Continue through the pinned direct OpenAI route or the explicitly authorized local route. Do not introduce a gateway or automatic model selector.
7. Do not repeat completed commands or builds unless a changed repository hash provides a new reason.

Until a fixed stable build is independently validated, long production tasks should avoid combining automatic compaction, Ultra reasoning, and subagents in one authority-bearing Windows Desktop turn. Subagents may still be used in bounded, externally checkpointed read-only investigations whose outputs are persisted before parent compaction.

## Resume criteria

Resume an affected turn only when:

- completion-criteria, completed-step, repository, diff, and next-action hashes match the checkpoint;
- completed subagent results are restored when applicable;
- no completed step has regressed to pending;
- repeated-command, repeated-build, reopened-resolution, and duplicate-subagent counters remain within the configured bound;
- all uncertain writes are reconciled.

Otherwise continue from the fresh guarded checkpoint rather than allowing the compacted turn to reconstruct state from memory.
