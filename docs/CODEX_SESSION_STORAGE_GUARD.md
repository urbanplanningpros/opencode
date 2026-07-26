# Codex Session Storage Guard

## Purpose

Codex Desktop can silently amplify screenshot-heavy session history when compaction re-persists inline image data and subagents inherit the full parent rollout. The guard audits storage metadata without reading or printing prompt, screenshot, or transcript contents.

## Audit

Run a point-in-time audit:

```bash
bun operator:codex-session-storage --json
```

Measure growth over 30 seconds while the affected thread is active:

```bash
bun operator:codex-session-storage \
  --duration-ms 30000 \
  --interval-ms 500 \
  --json
```

The guard reports:

- Total bytes and file count under `$CODEX_HOME/sessions`
- Largest rollout file
- Files above the configured warning size
- Available filesystem space
- Observed and projected session-store growth
- Whether the existing screenshot-heavy thread and full-context subagent forks are safe to continue

Default thresholds:

```text
Warning:  20 GiB total, 512 MiB per file, 20 GiB disk free, 1 GiB/hour growth
Critical: 50 GiB total,   2 GiB per file, 10 GiB disk free, 5 GiB/hour growth
```

Override thresholds with command flags or the matching `OPERATOR_CODEX_SESSION_*` environment variables.

## Active containment

The guard never deletes, truncates, or moves a session file. When it reports `warning` or `critical`:

1. Checkpoint the objective, acceptance criteria, decisions, changed files, pending writes, operation IDs, and continuation prompt outside Codex session history.
2. Stop resuming the screenshot-heavy thread. Start a fresh short-lived thread for the next phase.
3. Pass subagents a bounded text brief instead of inheriting the parent rollout.
4. Reconcile external writes before replaying anything after a storage, UI, or compaction failure.
5. Exit every Codex writer before cleanup. Use the supported `codex delete <session-id>` path rather than deleting an actively written JSONL file.

To cap subagent fan-out, apply the reversible configuration patch:

```bash
bun operator:codex-session-storage --apply-fork-limit --json
```

This backs up `config.toml` under:

```text
$CODEX_HOME/operator-backups/session-storage/<timestamp>/config.toml
```

and sets:

```toml
[agents]
max_concurrent_threads_per_session = 1
```

Review the backup and resulting config before restarting Codex.

## Continuity route

A storage threshold is not a reason to stop the entire operation. Continue through:

```text
Checkpoint provider-neutral state
→ fresh short-lived Codex thread with bounded text context
→ approved local route for safe offline analysis when needed
→ durable idempotent queue for connector writes
→ verify and reconcile external state
```

Do not route through Anthropic, Claude, Manus, model gateways, Bedrock, Vertex, or automatic Copilot model selection.
