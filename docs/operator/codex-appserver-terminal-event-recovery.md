# Codex app-server terminal-event recovery

Codex App Server 0.145.0 has a reported failure mode where a tool-enabled turn produces its final assistant output and valid artifact, accepts every tool result, and has no outstanding protocol work, but never emits `turn/completed`. A client that waits only for that event can block until timeout or replay work that already finished.

## Snapshot contract

Write an operation-scoped JSON snapshot after the final assistant output is received:

```json
{
  "schema_version": 1,
  "turn_id": "turn-id",
  "turn_completed_seen": false,
  "final_assistant_output_seen": true,
  "artifact_required": true,
  "artifact_verified": true,
  "external_write_attempted": false,
  "destination_verified": false,
  "tool_requests_total": 3,
  "tool_results_accepted": 3,
  "outstanding_tool_requests": 0,
  "outstanding_server_requests": 0,
  "outstanding_approvals": 0,
  "outstanding_protocol_items": 0,
  "outstanding_subagents": 0,
  "owned_background_processes": 0,
  "seconds_since_last_event": 10
}
```

Run the guard:

```bash
bun scripts/operator/codex-appserver-turn-completion-guard.mjs \
  --input /absolute/path/turn-snapshot.json \
  --json
```

## Decisions

- `protocol_complete`: Codex emitted `turn/completed`; continue normally.
- `verified_completion_without_terminal_event`: all obligations are settled, the artifact is verified, any external write is independently verified, and the quiet period elapsed. The client may record a local synthetic completion and continue without replaying the turn.
- `write_reconciliation_required`: an external write may have executed but its destination is not verified. Read the destination with the original operation identifier before replay.
- `terminal_state_not_proven`: keep the turn bounded and collect another snapshot. Do not create a replacement turn or retry external work.

The guard always sets `automatic_retry_allowed` to `false` when the protocol terminal event is absent.

## Integration rule

Do not treat final text alone as completion. A synthetic local completion requires:

1. all tool requests have accepted results;
2. no outstanding tool, server, approval, protocol, subagent, or owned background work;
3. the requested artifact is independently verified when required;
4. every external write is verified at its destination;
5. the configured quiet period has elapsed.

The generated evidence receipt belongs in the durable operator ledger, not in the Codex transcript.

## Validation

```bash
bun scripts/operator/codex-appserver-turn-completion-guard-selftest.mjs
```

The self-test covers normal protocol completion, safe synthetic completion, independently verified writes, uncertain writes, unfinished turns, evidence generation, and malformed input.
