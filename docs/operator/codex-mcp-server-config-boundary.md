# Codex MCP Server Configuration Boundary

## Incident

Codex CLI `0.145.0` accepts `-c` and `--config` on `codex mcp-server`, but a reported reproduction shows those process-level overrides do not reach the sessions created by the server. Sessions silently resolve from the active `CODEX_HOME/config.toml` instead. The same settings are effective when supplied through the `codex` tool call's `config` object.

## Approved continuity route

Do not stop unrelated MCP or operator work. Restrict only MCP sessions whose effective configuration has not been verified.

Use this sequence:

```text
Create an isolated CODEX_HOME for the MCP server
→ write the reviewed baseline config.toml
→ record its SHA-256 receipt
→ launch codex mcp-server without -c or --config
→ include task-specific values in each codex tool call config object
→ read session_configured
→ compare effective values with the approved task manifest
→ grant tool or write authority
```

Do not share the default `~/.codex` profile with an authoritative MCP server.

## Example baseline

```toml
model = "gpt-5.6-luna"
model_provider = "openai"

[agents]
enabled = false
max_concurrent_threads_per_session = 1
```

Keep secrets outside this file. Use a profile-specific absolute `CODEX_HOME` with restrictive ownership and permissions.

Launch without process overrides:

```bash
export CODEX_HOME=/var/lib/upp-operator/codex/mcp-openai-primary
codex mcp-server
```

Do not use:

```bash
codex mcp-server -c model='"gpt-5.6-luna"'
```

For every `codex` tool call, include the task-scoped configuration explicitly and preserve the operation ID and idempotency key outside provider memory.

## Admission evidence

Create a JSON evidence file after receiving `session_configured`:

```json
{
  "schema_version": 1,
  "route": "direct_openai",
  "codex_cli_version": "0.145.0",
  "codex_home": "/var/lib/upp-operator/codex/mcp-openai-primary",
  "default_codex_home": "/home/uppoperator/.codex",
  "config_path": "/var/lib/upp-operator/codex/mcp-openai-primary/config.toml",
  "approved_config_sha256": "REVIEWED_SHA256",
  "launch_args": ["mcp-server"],
  "per_call_config": {
    "model": "gpt-5.6-luna",
    "approvals_reviewer": "user"
  },
  "expected_session": {
    "model": "gpt-5.6-luna",
    "approvals_reviewer": "user"
  },
  "observed_session_configured": {
    "model": "gpt-5.6-luna",
    "approvals_reviewer": "user"
  },
  "write_authority_requested": true
}
```

Run:

```bash
node scripts/operator/codex-mcp-server-config-guard.mjs \
  --input /approved/task/mcp-session-config-evidence.json \
  --json
```

Exit behavior:

```text
0  effective session configuration verified
75 config hash, per-call config, or session_configured mismatch
64 unsafe launch, shared state, or prohibited route identifier
2  malformed evidence
```

## Recovery behavior

When the guard returns `75`:

1. Preserve the session ID, operation ID, configuration receipt, and observed event.
2. Withhold authority only from that session.
3. Start a replacement server with an isolated reviewed `CODEX_HOME`.
4. send task configuration through the per-call `config` object.
5. Verify `session_configured` before resuming.
6. Reconcile every uncertain external write before replay.

Resume the affected session only after its effective configuration matches the approved evidence. Do not reroute through a model gateway or automatic model selector.
