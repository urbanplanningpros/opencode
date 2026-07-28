# Codex remote exec-server parent lifecycle

## Trigger

Use this protocol for Codex remote exec servers launched by a local operator, app server, deployment worker, or automation process.

Upstream Codex added opt-in parent-lifetime controls through `--exit-on-stdin-close` and `CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE`. When enabled, the remote exec server treats its parent-owned stdin pipe as the lifetime authority, drains active work, terminates owned child processes, flushes telemetry, and exits after the parent closes the pipe.

Do not adopt the control blindly. A parent-owned subprocess and an intentionally standalone service require different lifecycle policy.

## Parent-owned mode

A subprocess owned by one operator process must use:

```text
stdin = pipe
process detached = false
--exit-on-stdin-close
or CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE=1
graceful drain = required
owned-child termination = required
telemetry flush = required
```

The parent-lifetime environment variable must not be inherited by workloads launched inside the exec server. Grandchild work is governed by the exec server's owned-process ledger, not by an environment value copied into arbitrary child processes.

Example plan:

```json
{
  "mode": "parent_owned",
  "route": "direct_openai",
  "transport": "stdio",
  "stdin": "pipe",
  "detached": false,
  "command": [
    "/absolute/path/to/codex",
    "exec-server",
    "--remote",
    "--exit-on-stdin-close"
  ],
  "env": {},
  "shutdown": {
    "graceful_drain": true,
    "terminate_owned_children": true,
    "flush_telemetry": true
  },
  "child_environment": {
    "inherits_parent_lifetime_control": false
  }
}
```

Run the admission guard before launch:

```bash
node scripts/operator/codex-exec-server-lifecycle-guard.mjs \
  --input /approved/task/exec-server-lifecycle.json \
  --json
```

Exit `0` permits the declared lifecycle. Exit `64` rejects it. Exit `2` reports malformed evidence.

## Standalone mode

A deliberately long-running service must not depend on stdin lifetime. It requires explicit supervision instead:

```text
exit-on-stdin-close = disabled
process detached = true
absolute PID file = required
bounded health check = required
bounded shutdown timeout = required
```

Example plan:

```json
{
  "mode": "standalone",
  "route": "authorized_local",
  "transport": "stdio",
  "stdin": "null",
  "detached": true,
  "command": [
    "/absolute/path/to/codex",
    "exec-server",
    "--remote"
  ],
  "env": {
    "CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE": "0"
  },
  "supervision": {
    "pid_file": "/approved/run/codex-exec-server.pid",
    "healthcheck": "GET http://127.0.0.1:4500/health",
    "shutdown_timeout_seconds": 30
  }
}
```

Do not detach a parent-owned server merely to keep it alive after a client crash. Restart it from preserved task state under a fresh parent and reconcile uncertain writes before replay.

## Promotion canary

Before enabling the upstream behavior in production:

1. Launch one parent-owned remote exec server with a real stdin pipe.
2. Start a read-only task and verify the server remains alive while the pipe is open.
3. Close the parent pipe without sending a normal shutdown signal.
4. Verify the server stops within the bounded shutdown interval.
5. Verify active sessions drain or receive a recorded terminal interruption.
6. Verify task-owned child processes terminate and unrelated processes remain alive.
7. Verify final telemetry is flushed.
8. Verify the parent-lifetime environment variable is absent from child workload environments.
9. Repeat after a signal-listener failure.
10. Run a standalone canary and verify closing its stdin does not terminate the supervised service.

## Failure handling

If the parent exits unexpectedly:

```text
Preserve the task manifest, operation IDs, idempotency keys and repository state
→ allow the parent-owned server to drain and exit
→ inspect for task-owned residual processes and listeners
→ mark unverified external writes uncertain
→ reconcile their destinations
→ start a fresh guarded server under a new parent
→ replay only operations proven not to have committed
```

Do not kill all processes matching `codex`, `node`, `git`, or a build-tool name. Terminate only processes linked to the recorded exec-server ownership tree.

If the installed Codex build does not support parent-stdin shutdown, keep the same lifecycle contract in the launcher: retain the stdin pipe, monitor the parent PID, terminate only owned descendants, flush the local operation ledger, and continue through the approved direct OpenAI or explicitly authorized local route.

## Authority boundary

The lifecycle control changes process ownership only. It does not grant model, connector, deployment, credential, plugin, or write authority. Exact tool allowlists, task-state preservation, idempotency, destination verification, and prohibited-route checks remain mandatory.
