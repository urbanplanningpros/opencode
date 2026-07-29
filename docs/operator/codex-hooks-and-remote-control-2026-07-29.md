# Codex hook and remote-control admission protocol

Date: 2026-07-29

## Hook boundary

Codex lifecycle hooks remain disabled until the runtime defines and verifies deterministic ordering between root/user hooks and plugin-provided hooks, plus deny short-circuit behavior that prevents later side-effect hooks from receiving a blocked prompt.

Use the guarded launcher:

```bash
bun scripts/operator/codex-hook-policy-safe-launch.mjs \
  -- \
  exec --ephemeral -
```

Verify the boundary before deployment:

```bash
bun scripts/operator/codex-hook-policy-safe-launch-selftest.mjs

bun scripts/operator/codex-hook-policy-safe-launch.mjs \
  --dry-run \
  -- \
  exec --ephemeral -
```

The dry-run receipt must include `--disable hooks`. The guard rejects both `--enable hooks` and `features.hooks=true`.

Do not treat a root `UserPromptSubmit` deny result as a privacy boundary while plugin hooks are also active. Prompt filtering, secret detection, and policy admission must occur before Codex receives the prompt.

## Experimental CLI remote control

The current developer-command reference documents these experimental commands:

```bash
codex remote-control start --json
codex remote-control pair --json
codex remote-control stop --json
```

The primary Remote Connections guide still describes desktop-app setup as required. Therefore the CLI/headless path is canary-only until the support contract is reconciled and a disposable end-to-end validation passes.

### Canary profile

Create a dedicated state profile owned by the unprivileged operator account:

```bash
install -d -m 0700 -o uppoperator -g uppoperator \
  /var/lib/upp-operator/codex/remote-control-canary-0146
```

Use a dedicated `config.toml`:

```toml
model = "gpt-5.6-luna"

[features]
hooks = false
remote_plugin = false
multi_agent_v2 = false
external_agent_memory_import = false

[agents]
enabled = false
max_concurrent_threads_per_session = 1
```

Launch only the pinned canary binary and dedicated profile:

```bash
sudo -u uppoperator env \
  CODEX_HOME=/var/lib/upp-operator/codex/remote-control-canary-0146 \
  /opt/codex-canary/0.146.0/bin/codex remote-control start --json

sudo -u uppoperator env \
  CODEX_HOME=/var/lib/upp-operator/codex/remote-control-canary-0146 \
  /opt/codex-canary/0.146.0/bin/codex remote-control pair --json
```

### Pairing receipt

Do not persist the raw pairing code in normal logs. Record only:

```json
{
  "codex_version": "0.146.0",
  "code_hash_sha256": "<sha256-of-pairing-code>",
  "environment_id": "<environmentId>",
  "expires_at": "<expiresAt>",
  "codex_home": "/var/lib/upp-operator/codex/remote-control-canary-0146",
  "hooks_disabled": true,
  "remote_plugins_disabled": true
}
```

Reject the pairing when `expiresAt` has passed. As a local policy, also reject a pairing response whose advertised lifetime exceeds 15 minutes.

### Authority and network controls

- Do not expose `codex app-server --listen` on a public or shared interface for this workflow.
- Keep existing host firewall and approved OpenAI egress policy authoritative.
- Treat the remote device as a control surface, not as an authority source.
- Require exact payload-bound approval receipts for connector, deployment, billing, email, CRM, database, and customer-facing writes.
- Preserve task IDs, operation IDs, idempotency keys, repository SHA, and state receipts on the host before remote continuation.
- Do not import sessions, plugins, memories, connectors, or configuration from excluded or automatically selected providers.

### Promotion gate

Promote the CLI/headless route only after a disposable canary proves all of the following twice:

1. Pairing succeeds using the pinned binary and dedicated `CODEX_HOME`.
2. The daemon survives a normal reconnect without duplicating the task or write operation.
3. A read-only repository task preserves the same thread ID and repository SHA across remote continuation.
4. A simulated write requires an exact independent approval receipt and executes only once.
5. `codex remote-control stop --json` terminates the daemon cleanly.
6. No public listener, plugin hook, remote plugin, external memory import, model gateway, or automatic provider selector appears in the effective runtime evidence.

Until then, continue production work through the guarded direct OpenAI route or the explicitly authorized local route.
