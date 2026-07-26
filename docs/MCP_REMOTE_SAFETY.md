# MCP and Privileged Remote Safety

## MCP stdio containment

Codex CLI `0.145.0` has open reports that MCP resource pagination can continue without a page or resource cap, and that tool-result metadata serialization failures can silently remove sandbox state. Until an upstream stable fix is validated, launch business-critical stdio MCP servers through the local guard.

```bash
export OPERATOR_MCP_UPSTREAM_COMMAND='["node","/absolute/path/to/server.mjs"]'
export OPERATOR_MCP_ALLOWED_TOOLS='["read_record","search_records"]'
export OPERATOR_MCP_MAX_RESOURCE_PAGES=100
export OPERATOR_MCP_MAX_RESOURCES=10000
export OPERATOR_MCP_MAX_MESSAGE_BYTES=8388608

bun operator:mcp-guard
```

Use the guard as the MCP server command in Codex rather than exposing the upstream executable directly.

The guard:

- Requires the upstream command as a JSON argument array.
- Denies every `tools/call` not present in the exact allowlist.
- Stops `resources/list` after the configured page or resource limit.
- Rejects MCP tool results that attempt to carry `codex/sandbox-state-meta` authority.
- Rejects oversized or malformed JSON messages.
- Forwards unaffected notifications and approved calls without shell interpolation.

An empty tool allowlist is deny-all. Do not configure broad wildcard tool access.

When the guard rejects a request, preserve the task state and isolate only that MCP server. Continue unaffected analysis through the approved OpenAI or local route. Connector and customer-facing writes must stay in the durable queue and be reconciled before replay.

## Context rollover

Long tool-heavy threads should be checkpointed before they depend on emergency compaction. At approximately 70% context usage, persist:

- Objective and acceptance criteria
- Decisions
- Changed files
- Operation and idempotency IDs
- Pending external writes
- Continuation prompt

Continue in a fresh thread. On `ContextWindowExceeded`, failed pre-turn compaction, or repeated broken-pipe errors, use the guarded HTTP-SSE recovery route once to checkpoint state, then move to a new thread.

## Privileged remote access

Do not provide a model with root, sudo, administrator, database-owner, or infrastructure passwords.

Use a dedicated service account and exact `sudo -n` allowlists. The account must not be able to execute credential-management commands, including:

```text
passwd
chpasswd
usermod -p
visudo
writes to /etc/sudoers or /etc/sudoers.d
SSH host-key rotation
writes to authorized_keys
PAM or authentication-policy changes
```

A legitimate credential change must be a separate human-approved task with an out-of-band console or break-glass recovery path. Verify access through a second authenticated session before closing the original session.
