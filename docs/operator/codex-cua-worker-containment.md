# Codex Desktop CUA worker containment

## Scope

A reported macOS Desktop defect can leave `cua_node/bin/node_repl` workers alive after recurring automations reach a terminal state. The workers are direct children of the Codex app server and may accumulate for hours.

This guard detects the condition without reading task content or terminating processes automatically.

## Audit

```bash
bun scripts/operator/codex-cua-worker-guard.mjs --json
```

To scope the audit to one app server:

```bash
bun scripts/operator/codex-cua-worker-guard.mjs \
  --pid "$CODEX_APP_SERVER_PID" \
  --json
```

The default recovery boundary is reached when any of these conditions is true:

- eight CUA `node_repl` workers are attached to the inspected app server set;
- the oldest worker has been alive for at least one hour; or
- aggregate worker RSS reaches 256 MiB.

The snapshot contains process identifiers, state, elapsed time, RSS, executable basename, and command hashes. It does not include task contents or full command arguments.

## Recovery

When the guard exits with code `2`:

1. Stop admitting new Desktop recurring-automation runs to the affected app server.
2. Checkpoint active task manifests, operation IDs, idempotency keys, changed files, and pending external writes.
3. Route new work to a fresh guarded direct OpenAI CLI process or the explicitly approved local route.
4. Reconcile every uncertain connector or deployment write before replay.
5. Close the affected Desktop/app-server instance through its normal shutdown path.
6. Verify its job-owned `cua_node/bin/node_repl` children exited.
7. Terminate only confirmed stale process trees through an approved host recovery command.
8. Re-run the guard and require `status: healthy` before releasing queued Desktop automations.

Do not use global `pkill`, weaken macOS security controls, or delete session state as a substitute for lifecycle cleanup.

An approved recovery executor may be configured as a JSON argument array:

```bash
export OPERATOR_CUA_WORKER_RECOVERY_COMMAND='["/absolute/path/to/drain-and-recycle-codex-appserver"]'

bun scripts/operator/codex-cua-worker-guard.mjs \
  --pid "$CODEX_APP_SERVER_PID" \
  --execute-recovery \
  --json
```

The recovery executor receives:

- `CODEX_APP_SERVER_PID`
- `OPERATOR_CUA_APP_SERVER_PIDS`
- `OPERATOR_CUA_WORKER_SNAPSHOT`
- `OPERATOR_CUA_WORKER_RECOVERY_REASON`

## Verification

Run the deterministic fixture test:

```bash
bun scripts/operator/codex-cua-worker-guard-selftest.mjs
```

Resume unattended Desktop recurring automations only after an updated Desktop build completes repeated short automation runs without monotonically increasing worker counts and all job-owned workers are reaped after completion, cancellation, error, and app-server shutdown.
