# Codex Remote Configuration Integrity

## Risk

Codex mobile or remote-control clients must not rewrite machine-wide host settings. A remote session may use a more restrictive per-turn policy, but it must not silently delete or replace approved values in `$CODEX_HOME/config.toml`.

The current known failure mode removes:

```toml
[sandbox_workspace_write]
network_access = true
```

from a connected macOS host after an iOS remote turn. That changes later desktop sessions as well as the remote turn.

## Establish a baseline

Run locally on each Codex host after reviewing the approved configuration:

```bash
bun operator:config-integrity --baseline
```

When network access is required for the host's approved workspace-write profile:

```bash
export OPERATOR_REQUIRE_CODEX_NETWORK_ACCESS=1
bun operator:config-integrity --verify
```

The baseline contains only the configuration hash, byte count, check time, and whether the approved network setting was present. It does not copy secrets or print the configuration body.

## Remote-use protocol

1. Checkpoint task state and queue external writes before opening a host from a mobile or remote client.
2. Run `bun operator:config-integrity --verify` immediately before the remote session.
3. Do not change machine-wide permissions from the remote client.
4. Run the verification again immediately after the remote turn.
5. If the guard reports `config_drift_requires_review`, stop only further remote-control turns. Continue safe work through guarded Codex CLI or the approved local route.
6. Preserve the current `config.toml` and the guard baseline before restoring any setting.
7. Restore settings only from a locally reviewed configuration, then create a new baseline.
8. Reconcile connector, deployment, email, CRM, database, billing, and customer-facing writes before replaying anything whose completion is uncertain.

## Resumption criteria

Remote control may resume after all of the following are true:

- The host configuration matches the locally approved policy.
- A fresh baseline has been created.
- A disposable remote canary does not mutate `config.toml`.
- A later local desktop turn retains the expected sandbox and network policy.
- No excluded provider, model gateway, or automatic model-selection route is introduced.
