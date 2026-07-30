# Codex sidebar continuation continuity

This protocol covers the Windows Codex Desktop failure reported in `openai/codex#36061` on July 30, 2026. On app build `26.721.41059`, **Continue in a new task** can fail reproducibly with `no rollout found for thread id ...` for both **Use this workspace** and **Use a new worktree**.

The source conversation remains the authority. A failed continuation is not permission to retry repeatedly, create duplicate tasks, or replay any action whose external-write state is uncertain.

## Admission command

```bash
node scripts/operator/codex-sidebar-continuation-guard.mjs \
  --input /approved/task/sidebar-continuation-evidence.json \
  --json

node scripts/operator/codex-sidebar-continuation-guard-selftest.mjs
```

Exit codes:

```text
0   continuation evidence verified
75  bounded checkpoint recovery or approved executor reroute required
64  replay, duplication, or prohibited-routing integrity failure
2   malformed invocation or evidence
```

## Native continuation

Before using **Continue in a new task**, record:

```text
source thread ID
operation ID
repository SHA
current diff SHA-256
external-write reconciliation state
selected continuation mode
```

Native continuation is admitted only when the source rollout is available, exactly one target task is created, the target appears in task history, and its workspace and repository state match the source checkpoint.

## Recovery after `no rollout found`

```text
Preserve the source thread unchanged
→ reconcile every possible connector, deployment, and repository write
→ do not repeat Continue in a new task
→ export a compact source checkpoint and SHA-256
→ create one explicitly bound target task
→ verify target task ID, task-list presence, workspace, repository SHA, and diff hash
→ initialize and verify the environment when a new worktree is used
→ continue only the exact unfinished action
```

The checkpoint must include:

```text
source thread ID
immutable completion criteria
current phase
exact next unfinished action
repository and commit SHA
current diff SHA-256
completed-step ledger
pending approvals
operation IDs and idempotency keys
uncertain-write state
required files and approved connectors
```

This is a compact state checkpoint, not a session import, memory import, provider bridge, or automatic handoff.

When Desktop cannot create a verified target task, continue through an explicitly authorized local or Linux executor after exporting the same checkpoint and reconciling all external writes. Preserve the Desktop thread as the control and audit surface.

## Evidence example

```json
{
  "app_build": "26.721.41059",
  "source_thread_id": "019fb099-4395-7262-bc53-b8658a0cda16",
  "operation_id": "operation-123",
  "repository_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "diff_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "continuation_attempted": true,
  "continuation_mode": "same_workspace",
  "continuation_route": "checkpoint_same_workspace",
  "no_rollout_found": true,
  "source_rollout_verified": false,
  "source_thread_preserved": true,
  "source_checkpoint_exported": true,
  "source_checkpoint_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "target_task_created": true,
  "target_task_id": "task-456",
  "target_task_indexed": true,
  "target_workspace_verified": true,
  "target_worktree_initialized": false,
  "repository_state_verified": true,
  "external_writes_reconciled": true,
  "automatic_retry_attempted": false,
  "replacement_task_created": false,
  "duplicate_continuation_created": false
}
```

## Promotion condition

Return native sidebar-continuation authority only after a corrected stable build passes repeated same-workspace and new-worktree canaries with:

```text
source rollout resolved
one target task only
target visible in task history
workspace and repository state preserved
worktree environment initialized when selected
no duplicate action or external write
```
