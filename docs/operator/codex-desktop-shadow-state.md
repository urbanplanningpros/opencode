# Codex Desktop shadow-state isolation

Codex Desktop may create `~/.codex/sqlite/codex-dev.db` even when its backend uses a custom `CODEX_HOME`. That database can contain Desktop automation, local-thread catalog, timeline, and feature-enablement state. A custom backend profile therefore does not, by itself, prove complete Desktop state isolation.

## Admission check

Run the guard before starting Desktop from an isolated operator profile:

```bash
node scripts/operator/codex-desktop-shadow-state-guard.mjs --json
```

For an explicit profile:

```bash
node scripts/operator/codex-desktop-shadow-state-guard.mjs \
  --codex-home "$CODEX_HOME" \
  --json
```

Exit codes:

- `0`: the configured profile is the default profile, or no shadow Desktop database exists.
- `75`: a Desktop database exists outside the configured profile; Desktop admission is blocked.
- `64`: the configured profile is missing or is not a directory.
- `2`: invalid command or path configuration.

The guard is read-only with respect to Codex state. It records evidence under the operator state directory and never deletes, moves, opens, repairs, or rewrites SQLite databases.

## Recovery route

When the guard exits `75`:

1. Preserve both the configured profile and `~/.codex/sqlite/codex-dev.db`.
2. Do not launch Desktop in that operating-system account.
3. Continue business-critical work through the guarded direct-OpenAI CLI or an explicitly authorized local route.
4. Use a dedicated operating-system account when strict Desktop account or client isolation is required.
5. Reconcile pending deployments and connector writes before replaying them.

Do not copy authentication files, plugin caches, local-thread catalogs, automation databases, rollout histories, or MCP state between isolated profiles.

## Validation

```bash
bun scripts/operator/codex-desktop-shadow-state-guard-selftest.mjs
```

The self-test covers the default profile, a clean isolated profile, a shadow database outside the configured profile, a non-file shadow path, evidence creation, no-mutation behavior, and invalid relative paths.
