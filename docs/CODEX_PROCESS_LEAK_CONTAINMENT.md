# Codex Process and Hidden-Disk Containment

## Scope

This protocol covers two local Codex Desktop failure modes reported against the `26.721.x` desktop family and bundled `0.146.0-alpha.3.1` runtime:

1. A sandboxed child process can continue after the exec tool appears to return, keep writing to a file after that file is deleted, and consume disk space invisibly.
2. Native Windows Desktop can retain one bundled `node_repl.exe` MCP process per opened thread until the app-server exits.

These are local process-lifecycle failures. They do not require a provider-routing change.

## Deleted-open-file guard for Linux and macOS

Audit the Codex app-server process and all descendants:

```bash
bun operator:orphan-output-guard \
  --pid "$CODEX_APP_SERVER_PID" \
  --json
```

Default recovery thresholds:

```text
1 GiB total across deleted open files
512 MiB in one deleted open file
10 GiB or less free on the monitored temp volume
```

The guard records only process metadata, byte counts, basenames, and hashes of paths. It does not print file contents or full paths.

A threshold breach exits `2` and writes a snapshot under:

```text
$OPERATOR_STATE_DIR/orphan-output-guard/
```

Optional recovery hook:

```bash
export OPERATOR_ORPHAN_OUTPUT_RECOVERY_COMMAND='[
  "node",
  "/absolute/path/to/approved-checkpoint-and-recycle.mjs"
]'

bun operator:orphan-output-guard \
  --pid "$CODEX_APP_SERVER_PID" \
  --execute-recovery \
  --json
```

A successful recovery command does not clear the alert. Run the guard again and require a healthy result.

## Windows `node_repl.exe` guard

Audit the native Windows Codex app-server:

```powershell
bun operator:node-repl-guard -AppServerPid $env:CODEX_APP_SERVER_PID -Json
```

The default recovery boundary is reached at any of:

```text
8 node_repl.exe descendants
900 aggregate handles
128 MiB aggregate working set
```

The guard creates a snapshot under:

```text
$OPERATOR_STATE_DIR/node-repl-guard/
```

It does not terminate processes automatically.

## Recovery protocol

When either guard reports `recovery_required`:

1. Stop admitting new threads, subagents, browser sessions, and MCP starts to the affected app-server.
2. Checkpoint task objective, acceptance criteria, decisions, changed files, pending writes, operation IDs, and the continuation prompt.
3. Route new safe work to a fresh approved OpenAI CLI process or the approved local route.
4. Reconcile every connector, deployment, email, database, CRM, billing, or customer-facing write before replay.
5. Exit the affected Desktop/app-server cleanly. If it does not exit, terminate the full descendant process tree through an approved host recovery script.
6. Verify deleted-open-file allocation has returned to zero or below threshold, free disk has recovered, and stale `node_repl.exe` descendants are gone.
7. Restart with a fresh state boundary and release queued work only after verification.

Do not delete a rapidly growing file while its writer may still be alive. Terminate and verify the writer first. Deleting the pathname does not release storage while a process retains the file descriptor.

## Preventive controls

- Run unattended shell commands with bounded wall time and bounded output size.
- Prefer non-interactive flags and redirect stdin from a known source; do not allow an interactive repair command to spin on EOF.
- Keep per-thread MCP and computer-use activity disabled unless explicitly required.
- Keep Codex subagents disabled under the existing quota guard.
- Do not share active app-server state across Desktop, native CLI, WSL, or different Codex versions.
- Keep durable task and write state outside Codex session history.
