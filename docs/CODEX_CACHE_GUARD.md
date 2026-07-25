# Codex Plugin-Cache Write-Amplification Guard

## Trigger

Codex CLI 0.145.0 has a reported remote-plugin catalog behavior in which repeated `plugin/list` requests can rewrite multi-megabyte cache files even when their contents are unchanged. Multiple Codex versions sharing one `CODEX_HOME` can amplify the writes by invalidating shared model and plugin caches.

Until OpenAI ships and validates an upstream fix, business-critical Codex CLI sessions should use the guarded launcher or the direct WSL route in this repository.

## Detect cache churn

Run a short audit while an affected Codex TUI session is open:

```bash
bun operator:codex-cache-audit --duration-ms 30000 --interval-ms 500 --json
```

The audit watches:

- `$CODEX_HOME/cache/remote_plugin_catalog/*.json`
- `$CODEX_HOME/cache/codex_apps_tools/*.json`
- `$CODEX_HOME/models_cache.json`

It records rewrites, byte-identical rewrites, bytes written, and an estimated daily write rate. The command exits with code `2` when observed churn exceeds the default threshold of 1 GiB/day. Override the threshold only for a documented diagnostic reason:

```bash
bun operator:codex-cache-audit --threshold-bytes-per-day 2147483648
```

## Continue work through the guarded route

Launch native Codex CLI with the remote plugin catalog disabled for that process:

```bash
bun operator:codex-safe -- exec --ephemeral -
```

The launcher inserts:

```text
--disable remote_plugin
```

It rejects any command-line attempt to re-enable `remote_plugin`. Local tools, installed project instructions, direct OpenAI execution, and the approved local continuity route remain available. Remote plugin marketplace discovery, install, update, and sharing may be unavailable while this guard is active.

For direct WSL operation from Windows:

```powershell
pwsh ./scripts/operator/codex-wsl-direct.ps1 -Distribution Ubuntu
```

The WSL launcher now uses an isolated Linux-native `CODEX_HOME` and also disables `remote_plugin`.

## Version isolation

Do not run different Codex CLI or app-server versions against the same active `CODEX_HOME` while this issue remains unresolved. Use one validated Codex version per state directory. Desktop and direct WSL routes must keep separate homes.

Do not copy SQLite databases, plugin catalogs, or model caches between versions. Preserve task objectives, acceptance criteria, decisions, and continuation prompts in the provider-neutral operator state instead.

## Restoration criteria

Remove the temporary `remote_plugin` guard only after:

1. OpenAI publishes a release containing a cache-write fix.
2. The updated version is tested with one Codex process and one `CODEX_HOME`.
3. A 30-minute cache audit remains below 1 GiB/day.
4. No byte-identical catalog rewrite loop appears.
5. Remote plugin and connector behavior is validated without using excluded providers or model gateways.

The guard does not delete caches, edit user configuration, rotate credentials, or stop unaffected OpenAI and approved-local workflows.
