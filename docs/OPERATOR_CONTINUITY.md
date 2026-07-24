# AI Operator Continuity Runbook

## What this patch provides

This repository now has a provider-neutral continuity layer around OpenCode, Codex, Claude Code, Manus, connectors, and CI/CD:

- Route profiles and circuit-breaker policy: `config/operator-routing.json`
- Durable task manifests and continuation state: `scripts/operator/init-task.mjs`
- File-backed durable write queue with idempotency keys: `scripts/operator/queue-action.mjs`
- Provider failover runner: `scripts/operator/run-with-failover.mjs`
- Hostile issue-content quarantine: `.github/workflows/agent-intake.yml`
- Protected-path and agent-PR gate: `.github/workflows/operator-policy.yml`
- Windows Codex state backup/recovery tool: `scripts/operator/recover-codex-state.ps1`

## Configure provider commands

Commands are JSON arrays, not shell strings. This prevents shell expansion and keeps arguments explicit.

```bash
export OPERATOR_OPENAI_COMMAND='["codex","exec","-"]'
export OPERATOR_ANTHROPIC_COMMAND='["claude","-p"]'
export OPERATOR_MANUS_COMMAND='["manus","run","-"]'
export OPERATOR_INCIDENT_PROFILE='continuity'
export OPERATOR_STATE_DIR="$HOME/.upp-operator-state"
```

Only configure commands that are installed, authenticated, and approved in the current environment. Missing providers are skipped without losing task state.

## Start and route a task

```bash
bun operator:init \
  --objective "Repair the failed build and preserve deployment readiness" \
  --acceptance "Build passes|Tests pass|No deployment files changed" \
  --allowed-paths "packages/opencode/**,packages/sdk/**" \
  --risk medium \
  --write

bun operator:route --task "$HOME/.upp-operator-state/tasks/<task-id>/manifest.json" --profile continuity
```

The runner checkpoints before execution, records every provider attempt, opens a circuit after repeated failures, and produces a continuation prompt for the next provider. Successful execution remains `awaiting_verification` until acceptance criteria are checked.

## Queue connector and automation writes

```bash
bun operator:queue \
  --action update_contact \
  --payload '{"contact_id":"123","status":"qualified"}' \
  --idempotency-key crm-contact-123-qualified-v1
```

A queue worker must claim one record atomically, execute it once, verify the target state, and move it from `pending` to `completed`. On timeout or provider loss, reconcile by `operation_id` and `idempotency_key` before replaying.

## Issue-to-agent workflow

1. GitHub issue content is captured in a quarantined artifact with no write permission.
2. A trusted operator converts it into a sanitized manifest containing the objective, acceptance criteria, allowed paths, prohibited actions, and risk.
3. A restricted agent works from that manifest in a disposable branch or worktree.
4. The agent opens a draft PR with these body fields:

```text
Sanitized-Manifest: <task-id or artifact reference>
Allowed-Paths: <approved paths>
```

5. Critical paths require the `operator-approved-critical` label and human review.
6. Protected CI/CD performs deployment after normal environment approvals.

## Windows Codex desktop recovery

Back up Codex state without changing it:

```powershell
pwsh ./scripts/operator/recover-codex-state.ps1
```

Preview removal of a broken secondary project root:

```powershell
pwsh ./scripts/operator/recover-codex-state.ps1 -RemovePath 'D:\path\to\secondary-root'
```

Apply only after reviewing the automatic backup:

```powershell
pwsh ./scripts/operator/recover-codex-state.ps1 -RemovePath 'D:\path\to\secondary-root' -Apply
```

The tool preserves `state_5.sqlite`; do not delete that database during workspace recovery.

## Recovery promotion

Move a recovered provider from canary to primary only after:

1. Vendor status is resolved.
2. Ten consecutive read-only canaries succeed.
3. Two controlled idempotent writes succeed.
4. No duplicate, truncated, missing, or stale tool results appear.
5. A rollback route remains configured.

Promote traffic in stages: 10% → 25% → 50% → 100%.
