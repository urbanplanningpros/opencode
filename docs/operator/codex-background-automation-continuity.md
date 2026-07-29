# Codex background automation continuity

This protocol covers eight Codex compatibility boundaries observed on July 29, 2026:

- new repository-backed cron automations may be created as Local because the macOS creation flow no longer exposes the Worktree selector;
- delegated or programmatic Worktree creation may skip the project’s selected local environment and setup script;
- a Local scheduled run may create its thread and emit initial reasoning but remain unable to invoke its first tool until a user opens the thread and resumes it;
- blocking MCP elicitation approvals may not produce the actionable notification used for command approvals on Windows;
- a Remote SSH endpoint may recover after sleep/wake while Codex Desktop remains disconnected until manually reconnected;
- a Remote Control sequence gap may leave the controller spinning after the canonical host turn has already completed;
- the app-server bundled with the stable VS Code extension may exit with `SIGILL` during long Linux/WSL2 sessions and fail to restart;
- a large-context Chat-to-Work continuation may wedge the macOS renderer and fail to create a durable target thread.

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

## Delegated Worktree environment initialization

A delegated or programmatically created Worktree is not ready merely because the directory and branch exist. Before any build, test, deployment, or repository write, require:

```text
selected_environment_bound = true
environment_manager_ready = true
setup_script_completed = true              # when a setup script is required
expected_artifacts_verified = true          # when a setup script is required
```

Use this sequence:

```text
create isolated worktree from pinned SHA
→ bind the project’s reviewed local environment explicitly
→ run the environment setup script inside that worktree
→ verify expected generated files and environment receipts
→ run one read-only environment-manager canary
→ grant build or write authority
```

Do not repair the Worktree by running an arbitrary shell bootstrap copied from another checkout. The setup command, environment ID, generated-artifact hashes, and worktree path must be recorded in the operation ledger.

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
→ inspect pending approvals
→ reconcile every possible external write
→ attach to the exact existing thread
→ resume once only when same_thread_resume_only = true
→ otherwise reroute through the authorized local scheduler
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
→ verify the same task ID
→ verify repository SHA and diff hash
→ verify pending approval and write ledger
→ resume only after state matches
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

## VS Code app-server native exit

Treat `SIGILL`, destroyed app-server stdin, or an unexpected native app-server exit as a state-reconciliation boundary.

```text
preserve the task and turn IDs
→ preserve repository SHA and diff hash
→ read durable command logs and destination state
→ classify the last command as completed, not dispatched, or unknown
→ restart the extension host or move execution to the approved local/Linux route
→ continue only the exact unfinished action
```

A failure is not recovered until:

```text
canonical_turn_state_reconciled = true
external_command_state_reconciled = true
continuation_route = same_thread | approved_local | approved_linux
```

Do not create a replacement session or automatically replay a command after the extension reports destroyed stdin. A command may have completed before the app-server exited.

Restore long-session authority to the affected extension build only after repeated WebSocket rollover, stream-reset, and multi-hour canaries prove that the app-server remains alive or restarts with the same task state.

## Large-context Chat-to-Work handoff

Until the large-context renderer failure is corrected, do not use direct `Continue in work mode` as the authoritative migration path for a mature thread.

Use a compact state checkpoint instead:

```text
source conversation ID and title
immutable completion criteria
current phase and exact next action
repository and commit SHA
current diff SHA-256
completed-step ledger
pending approvals
operation IDs and idempotency keys
uncertain-write state
required file and connector references
```

Then:

```text
preserve the source thread unchanged
→ create a fresh Work thread on the approved OpenAI route
→ paste or attach only the compact checkpoint
→ verify the target thread appears in Recents
→ verify renderer health and repository state
→ continue the exact next unfinished action
```

Do not replay the failed direct migration. Do not import an external provider session or use a model gateway as a handoff bridge.

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
  "worktree_environment": {
    "delegated_or_programmatic_creation": true,
    "selected_environment_bound": true,
    "setup_script_required": true,
    "setup_script_completed": true,
    "expected_artifacts_verified": true,
    "environment_manager_ready": true
  },
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
    "expires_at": "2026-07-29T23:00:00Z"
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
  },
  "app_server": {
    "used": false,
    "unexpected_exit": false,
    "destroyed_stdin_observed": false,
    "extension_host_restarted": false,
    "canonical_turn_state_reconciled": false,
    "external_command_state_reconciled": false,
    "automatic_replay_attempted": false,
    "replacement_session_created": false
  },
  "context_handoff": {
    "used": false,
    "large_context": false,
    "direct_work_migration_attempted": false,
    "manual_checkpoint_route_used": false,
    "source_checkpoint_exported": false,
    "source_thread_preserved": false,
    "target_thread_created": false,
    "target_thread_indexed": false,
    "renderer_healthy": false,
    "automatic_replay_attempted": false
  }
}
```

No excluded provider, model gateway, automatic selector, Amazon Bedrock, Google Vertex, or GitHub Copilot routing is permitted by this guard.
