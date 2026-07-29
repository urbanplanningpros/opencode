# Codex Windows IPC continuity

This protocol contains the Windows Codex Desktop app-server and browser-sidebar IPC failure reported in `openai/codex#35985` and corroborated by `openai/codex#35782`.

Affected evidence includes:

- Windows Store build `26.721.4979.0`;
- the Browser or Chrome sidebar client becoming stale or closing;
- `IpcRouter` reporting `EPIPE` during status broadcast or client unregistration;
- an uncaught Electron main-process `write EOF` exception;
- app-server stdio disconnection and unreliable interrupted-turn recovery;
- child build processes remaining alive after the Desktop host exits.

The goal is to isolate only the affected Windows Desktop or browser-control route while keeping guarded direct OpenAI planning, the approved Linux VPS, and explicitly authorized local Linux execution operating.

## Admission command

```bash
node scripts/operator/codex-windows-ipc-continuity-guard.mjs \
  --input /approved/task/codex-windows-ipc-evidence.json \
  --json
```

Exit codes:

```text
0   IPC continuity evidence verified
75  bounded state recovery or approved reroute required
64  unsafe replay, unapproved reroute, or prohibited-routing integrity failure
2   malformed invocation or evidence
```

## Preflight for the affected Windows build

For long-running or concurrent tasks on Desktop build `26.721.4979.0`, do not grant the bundled Browser or Chrome integration production authority unless the route has been proven safe on that host.

Use:

```text
Windows Desktop remains a control and review surface
→ disable the affected Browser/Chrome route
→ checkpoint task ID, operation ID, repository SHA and diff hash
→ execute browser or command work through the approved Linux VPS
   or explicitly authorized local Linux route
→ reconcile destination state before any retry
```

This is not a broad pause. Unaffected planning, code review, direct OpenAI use, repository inspection, and approved Linux execution continue.

## Failure recovery

After `EPIPE`, `write EOF`, or app-server disconnection:

```text
preserve the existing task and operation IDs
→ capture the last verified turn and repository state
→ inspect pending approvals
→ reconcile every possible external write by operation ID and idempotency key
→ read canonical task state
→ inventory surviving child processes
→ disable the affected Browser/Chrome IPC route
→ continue the exact unfinished action through an approved Linux route
```

Do not create a replacement task or automatically replay a shell, connector, deployment, database, CRM, billing, email, or customer-facing write.

Canonical task handling:

```text
completed
→ do not resume or replay
→ mark the Desktop projection stale

active
→ continue the same task only after state reconciliation

failed
→ continue from the preserved checkpoint through the approved route

unknown
→ withhold replay until the task and durable destination states are known
```

Child workloads such as Gradle or Kotlin daemons may survive the Desktop host. Inventory and bind them to the originating operation before deciding whether to keep or terminate them. Never kill unrelated workloads by process name alone.

## Evidence example

```json
{
  "task_id": "task-35985",
  "operation_id": "operation-35985",
  "platform": "Windows 11 x64",
  "desktop_build": "26.721.4979.0",
  "browser_integration_enabled": false,
  "browser_route_disabled": true,
  "long_running_task": true,
  "concurrent_task_count": 2,
  "browser_sidebar_client_closed": true,
  "epipe_observed": true,
  "write_eof_uncaught": true,
  "app_server_disconnected": true,
  "canonical_task_state": "failed",
  "uncertain_writes_reconciled": true,
  "interrupted_turn_reconciled": true,
  "child_processes_inventoried": true,
  "automatic_replay_attempted": false,
  "reroute_target": "approved_linux_vps"
}
```

## Resume condition

Restore production Browser/Chrome IPC authority on Windows only after a corrected stable build passes repeated client-close and concurrent-task canaries proving:

- no uncaught `EPIPE` or `EOF`;
- no app-server loss;
- correct same-task recovery;
- no orphan child workloads;
- no duplicate external writes;
- preserved repository and approval state.

No excluded provider, model gateway, automatic selector, Amazon Bedrock, Google Vertex, or GitHub Copilot routing is permitted by this protocol.
