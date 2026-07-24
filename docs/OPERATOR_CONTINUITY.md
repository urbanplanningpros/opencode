# AI Operator Continuity Runbook

## What this patch provides

This repository now has a provider-neutral continuity layer around OpenCode, Codex, Claude Code, approved connectors, and CI/CD:

- Provider and model route profiles with isolated circuit breakers: `config/operator-routing.json`
- Durable task manifests and continuation state: `scripts/operator/init-task.mjs`
- File-backed durable write queue with idempotency keys: `scripts/operator/queue-action.mjs`
- Single-claim queue executor with reconciliation routing: `scripts/operator/process-queue.mjs`
- Provider and model failover runner: `scripts/operator/run-with-failover.mjs`
- Audited Claude Code adapter: `scripts/operator/claude-wrapper.mjs`
- Hostile issue-content quarantine: `.github/workflows/agent-intake.yml`
- Protected-path and agent-PR gate: `.github/workflows/operator-policy.yml`
- Windows Codex state backup/recovery tool: `scripts/operator/recover-codex-state.ps1`

## Approved provider boundary

The runtime is limited to OpenAI and Anthropic routes defined in `config/operator-routing.json`. Manus is not an approved provider, bridge, connector, fallback, memory source, or deployment dependency. Do not add a Manus command, credential, endpoint, imported session, or automatic handoff path.

## Approved model routing

The runner controls the model separately from the provider and exports the selected route to the approved command wrapper:

```text
OPERATOR_PROVIDER
OPERATOR_MODEL
OPERATOR_MODEL_LANE
OPERATOR_MODEL_POLICY
```

Current Anthropic routing is:

```text
Primary:    claude-opus-4-8
Candidate:  claude-opus-5 at 10% of read-only tasks
Failure:    candidate circuit opens independently, then work returns to claude-opus-4-8
```

Claude Opus 5 remains a candidate until promotion criteria are satisfied. During the canary:

- Thinking remains adaptive and on by default.
- A wrapper must not combine disabled thinking with `xhigh` or `max` effort; the maximum permitted effort is `high`.
- Anthropic server-side `fallbacks: "default"` remains disabled so the exact executing model stays auditable.
- Mid-conversation tool changes remain disabled until connector authorization, prompt-cache behavior, and tool-removal handling are tested.
- The operator prompt avoids redundant verification instructions because Opus 5 already self-verifies more aggressively than Opus 4.8.
- The candidate runs in Claude Code bare mode, plan permission mode, and without session persistence.

The Claude adapter enforces the chosen model with `--model`, rejects unapproved Opus 5 policies, blocks Manus routes, and rejects piped prompts above Claude Code's 10MB limit.

## Configure provider commands

Commands are JSON arrays, not shell strings. This prevents shell expansion and keeps arguments explicit.

```bash
export OPERATOR_OPENAI_COMMAND='["codex","exec","-"]'
export OPERATOR_ANTHROPIC_COMMAND='["node","scripts/operator/claude-wrapper.mjs"]'
export OPERATOR_INCIDENT_PROFILE='continuity'
export OPERATOR_STATE_DIR="$HOME/.upp-operator-state"
export OPERATOR_ACTION_EXECUTOR_COMMAND='["node","path/to/approved-executor.mjs"]'
export OPERATOR_ACTION_TIMEOUT_SECONDS=300
export OPERATOR_PROCESSING_STALE_SECONDS=900
```

The Claude adapter expects the `claude` executable to be installed and authenticated. Set `OPERATOR_CLAUDE_BINARY` only when an approved installation uses a different executable path. Missing providers are skipped without losing task state.

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

The runner checkpoints before execution, records every provider and model attempt, opens model-specific circuits after repeated failures, and produces a continuation prompt for the next approved route. Successful execution remains `awaiting_verification` until acceptance criteria are checked.

## Queue connector and automation writes

```bash
bun operator:queue \
  --action update_contact \
  --payload '{"contact_id":"123","status":"qualified"}' \
  --idempotency-key crm-contact-123-qualified-v1
```

Run `bun operator:process` to claim one record atomically and pass it to the approved executor. The executor must return JSON containing `{"verified":true}` only after it confirms the target state. Duplicate idempotency keys return the existing record instead of creating another write. Failed, timed-out, or stale claimed actions move to `reconciliation` and are never blindly retried. Reconcile by `operation_id` and `idempotency_key` before replaying.

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

## Recovery and model promotion

Move a recovered provider or candidate model to primary only after:

1. Vendor status is resolved and stable.
2. Ten consecutive read-only canaries succeed.
3. Two controlled idempotent writes succeed after the candidate is explicitly enabled for writes.
4. No duplicate, truncated, missing, stale, or incorrectly formatted tool results appear.
5. Cost, latency, tool-call count, and human-correction rate are recorded against the current primary.
6. A rollback route remains configured.

Promote traffic in stages: 10% → 25% → 50% → 100%.
