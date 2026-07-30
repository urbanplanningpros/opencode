# Codex session rollout and MultiAgentV2 residency continuity

This protocol contains two newly observed failure classes without pausing unrelated operator work.

## Repeated user-session rollout replay

Trigger containment when two or more root `thread_source=user` rollouts share the same session ID and initial input-token baseline, while later rollouts replay hundreds of token events, grow to at least 50,000 input tokens or twice the baseline, or retain raw tool output records of at least 256 KiB.

Required recovery:

1. Preserve the canonical thread and rollout files unchanged.
2. Hash the affected rollout files and record the session, task, operation, repository, and idempotency identifiers.
3. Reconcile repository, deployment, and connector writes before any continuation.
4. Block additional duplicate rollout creation for the affected session.
5. Export a compact checkpoint containing completed work, exact next action, pending approvals, repository SHA, diff hash, and write reconciliation state.
6. Continue through a fresh projection of the same canonical thread or an explicitly approved local/Linux executor.

Do not replay the full history into another user-root rollout. Do not rely on `tool_output_token_limit` as proof that raw payloads were removed from persisted session history.

## MultiAgentV2 stale residency and false capacity

Treat `AgentLimitReached` as potentially false when the thread manager is below configured capacity, a completed runtime was touched during asynchronous eviction, or an immediate retry succeeds after the first reservation fails.

Required recovery:

1. Freeze only new MultiAgentV2 child admission for the affected operation.
2. Record manager residents, residency-LRU entries, eviction claims, exact runtime identity, and accepted follow-up work.
3. Reconcile stale residency and eviction claims against the exact runtime, not thread ID alone.
4. Reconcile whether follow-up work was accepted, started, persisted, completed, or interrupted.
5. Continue the exact unfinished action through guarded single-agent execution or an explicitly approved local/Linux route.

Do not automatically retry the failed reservation or respawn the child. A successful immediate retry is diagnostic evidence, not authorization to replay.

## Production promotion condition

Restore normal duplicate-rollout and MultiAgentV2 admission only after a corrected pinned stable build passes disposable tests covering repeated root-rollout creation, raw-output history pressure, concurrent follow-up during eviction, exact-runtime removal, stale residency cleanup, cancellation restoration, and same-operation reservation retry after reconciliation.
