# Codex background automation continuity

This protocol covers three Codex Desktop compatibility boundaries observed on July 29, 2026:

- new repository-backed cron automations may be created as Local because the macOS creation flow no longer exposes the Worktree selector;
- blocking MCP elicitation approvals may not produce the actionable notification used for command approvals on Windows;
- a Remote SSH endpoint may recover after sleep/wake while Codex Desktop remains disconnected until manually reconnected.

The goal is to isolate only the affected execution path while keeping guarded direct OpenAI and explicitly authorized local workflows operating.

## Admission command

```bash
node scripts/operator/codex-background-automation-continuity-guard.mjs \
  --input /approved/task/background-automation-evidence.json \
  --json
```

Exit codes:

```text
0   continuity evidence verified
75  bounded compatibility recovery or reroute required
64  approval-integrity or prohibited-routing failure
2   malformed invocation or evidence
```

## Repository-writing cron automations

A standalone cron automation that writes to a repository must satisfy all of the following:

```text
execution_environment = worktree
saved_configuration_read_back = true
runtime_worktree_observed = true
```

Do not create a repository-writing cron automation through a UI path that silently saves it as Local. Preserve an existing Worktree automation through the supported update interface and read the saved configuration back after every update. Verify the next real run creates an isolated worktree.

When no supported Worktree creation path is available, route the job through the explicitly authorized local scheduler. That scheduler must create a temporary worktree from a pinned repository SHA, use a deterministic branch name tied to the automation and operation IDs, and remove the worktree only after the diff, commit, and external-write ledger are preserved.

Heartbeat automations and non-writing tasks do not require a new worktree merely because they are scheduled.

## Blocking MCP approvals

A blocking approval is not admitted unless its exact request is visible and bound to:

```text
approval request ID
operation ID
idempotency key in the external task ledger
canonical payload SHA-256
expiration timestamp
```

An actionable desktop notification is preferred. When the product does not provide one, an active read-only approval watchdog may surface the exact pending request and move the task to a foreground approval surface. The watchdog must never approve, rewrite, or replay the request.

Do not interpret progress text, a green task tag, or a generic attention badge as approval authority.

## Remote reconnection

When the SSH endpoint becomes reachable after sleep or transport loss:

```text
reconnect once
verify the same task ID
verify repository SHA and diff hash
verify pending approval and write ledger
resume only after state matches
```

Do not recreate the task or replay an uncertain write merely because the Desktop connection still appears disconnected.

## Evidence example

```json
{
  "task_id": "task-123",
  "automation_id": "automation-123",
  "automation_type": "cron",
  "repository_backed": true,
  "writes_repository": true,
  "execution_environment": "worktree",
  "saved_configuration_read_back": true,
  "runtime_worktree_observed": true,
  "uncertain_writes_reconciled": true,
  "pending_approval": {
    "blocking": true,
    "event_type": "mcp_resolve_elicitation",
    "exact_request_visible": true,
    "actionable_notification_observed": false,
    "approval_watchdog_active": true,
    "request_id": "approval-123",
    "operation_id": "operation-123",
    "payload_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "expires_at": "2026-07-29T13:00:00Z"
  },
  "remote_connection": {
    "used": true,
    "endpoint_reachable": true,
    "app_reconnected": true,
    "task_identity_verified": true,
    "state_verified": true
  }
}
```

No excluded provider, model gateway, automatic selector, Amazon Bedrock, Google Vertex, or GitHub Copilot routing is permitted by this guard.
