# AI Operator Continuity Runbook

## What this patch provides

This repository uses an OpenAI-first continuity layer with an optional approved local execution route:

- Provider and model route profiles with isolated circuit breakers: `config/operator-routing.json`
- Durable task manifests and continuation state: `scripts/operator/init-task.mjs`
- File-backed durable write queue with idempotency keys: `scripts/operator/queue-action.mjs`
- Single-claim queue executor with reconciliation routing: `scripts/operator/process-queue.mjs`
- Provider and model failover runner: `scripts/operator/run-with-failover.mjs`
- Local Gmail MIME attachment executor: `scripts/operator/gmail-send-local.mjs`
- Hostile issue-content quarantine: `.github/workflows/agent-intake.yml`
- Protected-path and agent-PR gate: `.github/workflows/operator-policy.yml`
- Windows Codex state backup/recovery tool: `scripts/operator/recover-codex-state.ps1`

## Approved provider boundary

The operator runtime is limited to OpenAI and an explicitly configured local route. Anthropic, Claude, and Manus are prohibited as providers, models, connectors, bridges, fallbacks, memory sources, handoff destinations, imported sessions, or deployment dependencies.

The route runner rejects any configured provider or model ID containing `anthropic`, `claude`, or `manus` before execution.

## Approved model routing

```text
Normal and continuity:
  OpenAI gpt-5.6-sol
  OpenAI gpt-5.6-terra
  Approved local route

OpenAI degraded:
  Approved local route
  10% read-only OpenAI recovery canary
  OpenAI fallback after local exhaustion
```

The approved local command must run in a restricted environment with network access denied by default and no production secrets.

## Configure provider commands

Commands are JSON arrays, not shell strings. This prevents shell expansion and keeps arguments explicit.

```bash
export OPERATOR_OPENAI_COMMAND='["codex","exec","-"]'
export OPERATOR_LOCAL_COMMAND='["node","/path/to/approved-local-operator.mjs"]'
export OPERATOR_INCIDENT_PROFILE='continuity'
export OPERATOR_STATE_DIR="$HOME/.upp-operator-state"
export OPERATOR_ACTION_EXECUTOR_COMMAND='["node","path/to/approved-executor.mjs"]'
export OPERATOR_ACTION_TIMEOUT_SECONDS=300
export OPERATOR_PROCESSING_STALE_SECONDS=900
```

Do not configure any Anthropic, Claude, or Manus credential, command, endpoint, model alias, Copilot auto-model route, Bedrock model access, Vertex publisher model, or model-gateway fallback.

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

Run `bun operator:process` to claim one record atomically and pass it to the approved executor. The executor must return JSON containing `{"verified":true}` only after it confirms the target state. Duplicate idempotency keys return the existing record instead of creating another write. Failed, timed-out, or stale claimed actions move to `reconciliation` and are never blindly retried.

## Gmail attachment compatibility fallback

Codex Desktop for Windows may temporarily advertise an outdated flat Gmail send schema while the connector runtime expects a newer MIME message object. When this mismatch appears, attachment sends fail during argument binding before Gmail receives the message.

Do not retry the legacy `attachment_files` action. Queue a local Gmail API write instead:

```bash
PAYLOAD=$(node -e 'process.stdout.write(JSON.stringify({
  to:["recipient@example.com"],
  subject:"Requested documents",
  body_text:"Attached are the requested documents.",
  attachments:[{path:process.argv[1]}]
}))' "/approved/path/report.pdf")

bun operator:queue \
  --action gmail_send \
  --payload "$PAYLOAD" \
  --idempotency-key gmail-recipient-report-v1

export OPERATOR_ACTION_EXECUTOR_COMMAND='["node","scripts/operator/gmail-send-local.mjs"]'
export OPERATOR_GMAIL_ATTACHMENT_ROOTS="/approved/path"
export OPERATOR_GMAIL_MAX_ATTACHMENT_BYTES=20971520
export GOOGLE_GMAIL_ACCESS_TOKEN="<narrowly-scoped-runtime-token>"

bun operator:process
```

The Gmail executor:

- Builds an RFC 5322 MIME message locally.
- Reads attachments only from approved roots.
- Rejects header injection and non-file attachments.
- Uses a deterministic Message-ID derived from the idempotency key.
- Searches Gmail for that Message-ID before sending, preventing duplicate replay.
- Verifies the stored Gmail message and operation header after sending.
- Returns `verified=true` only after that verification succeeds.

The Gmail access token belongs only in the connector executor environment. Do not expose it to Codex, the local model route, build agents, task prompts, repository files, or CI logs.

## Issue-to-agent workflow

1. GitHub issue content is captured in a quarantined artifact with no write permission.
2. A trusted operator converts it into a sanitized manifest containing the objective, acceptance criteria, allowed paths, prohibited actions, and risk.
3. A restricted approved agent works from that manifest in a disposable branch or worktree.
4. The agent opens a draft PR containing its sanitized-manifest and allowed-path references.
5. Critical paths require explicit operator approval and human review.
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

Move a recovered route to primary only after:

1. Vendor status is resolved and stable.
2. Ten consecutive read-only canaries succeed.
3. Two controlled idempotent writes succeed after the route is explicitly enabled for writes.
4. No duplicate, truncated, missing, stale, or incorrectly formatted tool results appear.
5. Cost, latency, tool-call count, and human-correction rate are recorded against the current primary.
6. A non-Claude rollback route remains configured.

Promote traffic in stages: 10% → 25% → 50% → 100%.
