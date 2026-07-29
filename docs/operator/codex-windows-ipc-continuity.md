# Codex Windows IPC and process-telemetry continuity

This protocol contains the Windows Codex Desktop app-server/browser-sidebar IPC failure reported in `openai/codex#35985`, corroborated by `openai/codex#35782`, and the repeated PowerShell/WMI process-snapshot pressure reported in `openai/codex#36025`.

Affected evidence includes:

- Windows Store build `26.721.4979.0`;
- the Browser or Chrome sidebar client becoming stale or closing;
- `IpcRouter` reporting `EPIPE` during status broadcast or client unregistration;
- an uncaught Electron main-process `write EOF` exception;
- app-server stdio disconnection and unreliable interrupted-turn recovery;
- child build processes remaining alive after the Desktop host exits;
- Windows Store build `26.721.11231.0` repeatedly launching short-lived PowerShell children that query `Win32_Process` and `Win32_PerfFormattedData_PerfProc_Process`;
- measured WMI snapshot rates around one or more calls per second with system-wide mouse, drag, or input lag.

The goal is to isolate only the affected Windows Desktop execution route while keeping guarded direct OpenAI planning, the approved Linux VPS, and explicitly authorized local Linux execution operating.

## Admission command

```bash
node scripts/operator/codex-windows-ipc-continuity-guard.mjs \
  --input /approved/task/codex-windows-ipc-evidence.json \
  --json
```

Exit codes:

```text
0   Windows continuity evidence verified or pressure safely contained
75  bounded state recovery, Desktop isolation, or approved reroute required
64  unsafe replay, unsafe WMI suppression, unapproved reroute, or prohibited-routing failure
2   malformed invocation or evidence
```

## IPC preflight

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

## WMI process-snapshot pressure

On Windows Desktop build `26.721.11231.0`, treat any of the following as pressure evidence:

- system-wide mouse, drag, or typing lag that begins after Desktop starts;
- repeated short-lived `powershell.exe` children owned by the Desktop process tree;
- recurring `Get-CimInstance Win32_Process` or `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process` commands;
- a measured full-process WMI snapshot rate of at least one call per second;
- WMI Activity errors associated with those snapshots.

When pressure is present:

```text
checkpoint every active task and operation
→ preserve repository SHA, diff hash, approvals, and idempotency evidence
→ reconcile possible connector or deployment writes
→ remove local-execution authority from the affected Desktop process
→ gracefully exit Desktop when lag persists
→ continue the exact unfinished action through the approved Linux VPS
   or explicitly authorized local Linux route
```

Do not patch the packaged application to return an empty process list, block WMI calls indiscriminately, or replace the snapshot command with a fake success. The upstream A/B test found that empty results can amplify retries and can interfere with child-process discovery and cleanup.

Lowering the Desktop process priority is not an admission control because `WmiPrvSE.exe` work occurs outside the Codex process tree and the query rate remains unchanged.

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
  "task_id": "task-36025",
  "operation_id": "operation-36025",
  "platform": "Windows 11 x64",
  "desktop_build": "26.721.11231.0",
  "browser_integration_enabled": false,
  "browser_route_disabled": true,
  "long_running_task": true,
  "concurrent_task_count": 1,
  "browser_sidebar_client_closed": false,
  "epipe_observed": false,
  "write_eof_uncaught": false,
  "app_server_disconnected": false,
  "canonical_task_state": "active",
  "uncertain_writes_reconciled": true,
  "interrupted_turn_reconciled": true,
  "child_processes_inventoried": true,
  "automatic_replay_attempted": false,
  "system_wide_input_lag_observed": true,
  "powershell_wmi_snapshot_children_observed": true,
  "wmi_snapshot_rate_per_second": 1.2,
  "wmi_activity_error_observed": false,
  "desktop_execution_isolated": true,
  "unsafe_wmi_suppression_applied": false,
  "reroute_target": "approved_linux_vps"
}
```

## Resume condition

Restore affected Windows Desktop production authority only after a corrected stable build passes repeated IPC, idle, and active-task canaries proving:

- no uncaught `EPIPE` or `EOF`;
- no app-server loss;
- no recurring PowerShell full-process WMI snapshots during idle or active work;
- no system-wide input lag;
- no retry amplification when process snapshots return slowly or fail;
- correct same-task recovery;
- no orphan child workloads;
- no duplicate external writes;
- preserved repository and approval state.

No excluded provider, model gateway, automatic selector, Amazon Bedrock, Google Vertex, or GitHub Copilot routing is permitted by this protocol.
