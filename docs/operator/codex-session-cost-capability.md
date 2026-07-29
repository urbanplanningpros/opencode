# Codex session cost and capability continuity

This protocol covers three bounded Codex failure modes reported after the stable `0.146.0` release:

- a long API-key session can resume after idle with a large uncached context and no resume-time cost warning (`openai/codex#35925`);
- a stale locally cached ChatGPT plan claim can suppress a hosted capability such as `image_generation` until the dedicated profile is reauthenticated and a fresh session is started (`openai/codex#35923`);
- the VS Code extension can report its feature-gate provider as ready while no gate values were loaded after a network initialization failure (`openai/codex#35924`).

The guard preserves direct OpenAI and explicitly authorized local continuity. It does not add a model gateway, automatic selector, alternate provider, imported session, proxy dependency, or excluded-provider route.

## Session resume cost boundary

Run before resuming a large, idle API-backed Codex session:

```bash
node scripts/operator/codex-session-cost-capability-guard.mjs \
  --input /approved/task/session-resume-evidence.json \
  --json
```

Minimum evidence:

```json
{
  "mode": "session_resume_cost",
  "operation_id": "immutable-operation-id",
  "selected_model": "gpt-5.6-luna",
  "provider": "openai",
  "route": "direct_openai",
  "context_tokens": 250000,
  "idle_seconds": 2400,
  "cache_state": "unknown",
  "input_usd_per_million": 1,
  "task_state_checkpointed": true,
  "pending_writes_reconciled": true,
  "resume_strategy": "fresh_guarded_turn"
}
```

The default warning boundary is 131,072 context tokens after at least 300 idle seconds or whenever cache state is unknown or cold. The defaults are configurable evidence values, not assumptions about a guaranteed server-side cache lifetime.

When the boundary is crossed:

1. Persist the provider-neutral task manifest, concise continuation summary, current diff, operation ID, and every idempotency key.
2. Reconcile uncertain connector, deployment, billing, database, email, or customer-facing writes.
3. Start a fresh guarded direct-OpenAI turn from the checkpoint, or use the explicitly authorized local route.
4. Record `cached_tokens` and `cache_write_tokens` from subsequent API usage when available.
5. Resume the same large session only after explicit acknowledgement of the possible uncached input cost.

The guard also identifies the configurable long-context pricing boundary, defaulting to 272,000 input tokens. Pricing must be supplied from a current approved receipt when a currency estimate is required.

## Hosted capability and auth-state boundary

Run when a feature is enabled in configuration but absent from the effective tool catalog:

```bash
node scripts/operator/codex-session-cost-capability-guard.mjs \
  --input /approved/task/auth-capability-evidence.json \
  --json
```

A mismatch between the authoritative plan and the cached plan claim, a stale subscription timestamp, or a missing required capability blocks only the dependent hosted capability.

Recovery:

```text
Preserve task state
→ use the normal OpenAI browser login for the dedicated CODEX_HOME
→ start a brand-new guarded session
→ recapture the effective feature list
→ resume only after the plan and capability agree
```

Do not delete auth files, modify token claims, copy credentials between profiles, or copy plugin, MCP, session, or authentication state into another `CODEX_HOME`.

## VS Code feature-gate health boundary

A feature-gate provider reporting `Ready` or refresh `success=true` is not healthy evidence when `has_values=false`.

When that state is observed:

```text
Treat only the extension capability surface as degraded
→ preserve the task manifest
→ continue through guarded direct-OpenAI CLI/VPS
→ or use the explicitly authorized local continuity route
```

Do not patch individual UI gates or add an unapproved proxy route. Core API work that remains healthy can continue outside the degraded extension surface.

## Exit codes

```text
0   bounded route or refreshed capability verified
75  checkpoint, reauthentication, fresh-session, or compatibility reroute required
64  prohibited provider, gateway, automatic selector, or routing metadata
2   malformed invocation or evidence
```
