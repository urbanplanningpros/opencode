# Codex background automation continuity

This protocol covers five Codex Desktop compatibility boundaries observed on July 29, 2026:

- new repository-backed cron automations may be created as Local because the macOS creation flow no longer exposes the Worktree selector;
- a Local scheduled run may create its thread and emit initial reasoning but remain unable to invoke its first tool until a user opens the thread and resumes it;
- blocking MCP elicitation approvals may not produce the actionable notification used for command approvals on Windows;
- a Remote SSH endpoint may recover after sleep/wake while Codex Desktop remains disconnected until manually reconnected;
- a Remote Control sequence gap may leave the controller spinning after the canonical host turn has already completed.

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
64  approval, replay, or prohibited-routing integrity failure
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

## Local scheduled background execution

A Local scheduled cron run is not trusted as unattended merely because its thread exists or the UI says it is running. Admission requires:

```text
background_driver_verified = true
first_tool_started = true
progress_heartbeat_observed = true
manual_resume_required = false
```

If the scheduled thread stalls before its first tool call:

```text
preserve the existing task and turn IDs
inspect pending approvals
reconcile every possible external write
attach to the exact existing thread
resume once only when same_thread_resume_only = true
otherwise reroute through the authorized local scheduler
```

Never create a replacement task or replay a tool call simply because the scheduled thread appears active but has no progress owner.

Native Local unattended authority should return only after a corrected stable build completes three consecutive scheduled canaries with the app left untouched, a verified background driver, tool execution, progress heartbeats, and terminal completion.

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

## Remote reconnection and sequence gaps

When an SSH endpoint becomes reachable after sleep or transport loss:

```text
reconnect once
verify the same task ID
verify repository SHA and diff hash
verify pending approval and write ledger
resume only after state matches
```

When a Remote Control log reports a sequence gap, the controller spinner and task-detail projection are no longer authoritative. Reconcile against the canonical host state:

```text
canonical host = completed
→ do not resume or retry
→ mark the controller projection stale
→ resync or reconnect the view

canonical host = active
→ continue the existing task only
→ do not create a replacement task

canonical host = unknown
→ preserve state and reconcile durable destinations
→ withhold replay until task and write state are known
```

A host-completed task must never receive another `thread/resume` merely to clear a stale spinner.

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
  "scheduled_execution": {
    "background_driver_verified": true,
    "first_tool_started": true,
    "progress_heartbeat_observed": true,
    "manual_resume_required": false,
    "same_thread_resume_only": true
  },
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
    "state_verified": true,
    "sequence_gap_detected": false,
    "canonical_host_state": "active",
    "canonical_state_reconciled": true,
    "controller_projection_resynced": true,
    "resume_attempted": false
  }
}
```

No excluded provider, model gateway, automatic selector, Amazon Bedrock, Google Vertex, or GitHub Copilot routing is permitted by this guard.
