# Codex Session Storage and Subagent Quota Guard

## Purpose

Codex can silently amplify operating cost and local storage through two related paths:

1. Screenshot-heavy sessions can re-persist inline images during compaction and copy the inflated parent rollout into subagent forks.
2. MultiAgent V2 can recursively create subagents even though the legacy `agent_max_depth` setting does not govern that path. A reported Codex CLI 0.145.0 session created a deep subagent tree and exhausted a weekly usage allowance overnight.

OpenAI's current Codex model catalog marks GPT-5.6 Sol and GPT-5.6 Terra as `multi_agent_version: "v2"`, while GPT-5.6 Luna is explicitly marked `v1`. An older but still-open report shows GPT-5.5 forced V2 in Codex 0.142.5 despite local disables, so GPT-5.5 is not treated as quota-safe until that release-dependent behavior is independently validated. During containment, the approved direct-OpenAI canary model is GPT-5.6 Luna with all subagent execution disabled. The approved local route remains first in the default degraded profile.

The guard audits storage metadata without reading or printing prompt, screenshot, or transcript contents. It can also apply a reversible single-agent configuration that prevents recursive subagent execution while leaving ordinary Codex and local work operational.

## Audit

Run a point-in-time audit:

```bash
bun operator:codex-session-storage --json
```

Measure growth over 30 seconds while an affected thread is active:

```bash
bun operator:codex-session-storage \
  --duration-ms 30000 \
  --interval-ms 500 \
  --json
```

The guard reports:

- Total bytes and file count under `$CODEX_HOME/sessions`
- Largest individual rollout
- Available filesystem space
- Observed and projected session-store growth
- Whether the existing screenshot-heavy thread is safe to continue
- Whether the single-agent quota guard is active

Full-parent-context forking is reported unsafe while this containment policy is in force.

Default thresholds:

```text
Warning:  20 GiB total, 512 MiB per file, 20 GiB disk free, 1 GiB/hour growth
Critical: 50 GiB total,   2 GiB per file, 10 GiB disk free, 5 GiB/hour growth
```

Override thresholds with command flags or the matching `OPERATOR_CODEX_SESSION_*` environment variables.

## Apply the quota guard

Run this against every active Desktop, native CLI, WSL, and worker `CODEX_HOME`:

```bash
bun operator:codex-session-storage \
  --apply-subagent-quota-guard \
  --json
```

For backward compatibility, `--apply-fork-limit` now applies the same stronger guard.

Before changing anything, the command backs up `config.toml` under:

```text
$CODEX_HOME/operator-backups/subagent-quota/<timestamp>/config.toml
```

It then atomically enforces:

```toml
[agents]
enabled = false
max_concurrent_threads_per_session = 1
```

`enabled = false` is required. A concurrency cap alone is insufficient because serially created MultiAgent V2 children can still recurse and consume quota. The guarded launchers additionally disable `multi_agent_v2` and force GPT-5.6 Luna, avoiding the models currently cataloged as V2 while preserving a direct OpenAI route.

Review the backup and resulting configuration before restarting Codex.

## Approved launch routes

Native CLI:

```bash
bun operator:codex-safe -- exec --ephemeral -
```

Direct WSL:

```powershell
pwsh ./scripts/operator/codex-wsl-direct.ps1 -Distribution Ubuntu
```

Both launchers enforce:

```text
model: gpt-5.6-luna
catalog multi-agent version: v1
multi_agent_v2: disabled
agents.enabled: false
max_concurrent_threads_per_session: 1
```

They reject GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.5, Ultra reasoning, or attempts to re-enable MultiAgent V2 while containment is active.

## Operating protocol

Until OpenAI ships a stable fix and validates quota accounting:

1. Keep the default `openai_degraded` profile: approved local first, with only eligible read-only OpenAI canaries.
2. Run direct OpenAI Codex canaries on GPT-5.6 Luna in single-agent mode.
3. Do not invoke `spawn_agent`, recursive delegation, inherited full-context forks, unattended subagent trees, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.5, or Ultra reasoning.
4. For parallel offline analysis, launch separately authorized local workers with bounded text manifests and independent state directories.
5. Keep connector, deployment, CRM, email, database, and customer-facing writes in the durable idempotent queue.
6. Reconcile external state before replaying anything after a quota, storage, UI, or compaction failure.
7. Checkpoint objective, acceptance criteria, decisions, changed files, pending writes, operation IDs, and continuation instructions outside Codex history.
8. Move screenshot-heavy work into fresh short-lived threads rather than repeatedly resuming one image-heavy session.
9. Exit every Codex writer before cleanup and use the supported `codex delete <session-id>` path rather than deleting an active rollout.

A quota or storage threshold is not a reason to stop the broader operation. Continue through:

```text
Provider-neutral checkpoint
→ approved local route for bounded offline work
→ quota-contained GPT-5.6 Luna read-only canaries when needed
→ durable idempotent queue for external writes
→ verify and reconcile target state
```

## Promotion criteria

Do not restore GPT-5.6 V2 models, GPT-5.5, or Codex subagents until all of the following are true:

1. OpenAI publishes a stable release containing a confirmed MultiAgent V2 nesting and quota-accounting fix.
2. A controlled canary proves no recursive children are created beyond the requested topology.
3. Usage metering matches the sum of actual canary requests without replayed ancestor token events.
4. The canary stays within a defined daily and weekly usage budget.
5. Screenshot-heavy and compacted sessions do not duplicate full parent histories into child rollouts.
6. Rollback to GPT-5.6 Luna, `agents.enabled = false`, and the approved local-first profile is tested.

Do not route through Anthropic, Claude, Manus, model gateways, GitHub Copilot auto-selection, Bedrock, or Vertex.
