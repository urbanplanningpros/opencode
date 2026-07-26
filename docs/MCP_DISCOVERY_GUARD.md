# MCP Discovery Guard

## Purpose

Codex Desktop can retain disabled plugin-managed MCP server definitions in `config.toml` and expose standard-looking `.mcp.json` files in plugin cache directories. Third-party tools that automatically import agent MCP configurations may ignore Codex-specific `enabled = false` metadata and attempt to launch those servers.

The current known case involves the bundled `computer-use` server using a relative command and `cwd = "."`. Outside Codex's internal launch context, that definition is not reliably resolvable and can create repeated MCP spawn and connection failures in other tools.

## Audit

Run the host audit before enabling any third-party MCP auto-import or auto-spawn feature:

```bash
bun operator:mcp-discovery-audit --json
```

The audit checks:

- `$CODEX_HOME/config.toml` or `~/.codex/config.toml`
- `$CODEX_HOME/plugins/cache/**/.mcp.json`
- `$CODEX_HOME/.tmp/bundled-marketplaces/**/.mcp.json`

It exits with code `2` when a disabled TOML entry or discoverable cache entry for `computer-use` uses a relative command or `cwd = "."`.

## Reversible remediation

Remove the disabled TOML block and quarantine the matching cache entries:

```bash
bun operator:mcp-discovery-audit --apply --quarantine-cache --json
```

Before editing, the guard copies every changed file to:

```text
$CODEX_HOME/operator-backups/mcp-discovery/<timestamp>/
```

The backup directory contains the original files and a `manifest.json` recording findings and changes.

The guard modifies only the selected server, which defaults to `computer-use`. Other MCP definitions remain unchanged.

To audit another server explicitly:

```bash
bun operator:mcp-discovery-audit --server <server-name> --json
```

## Operating protocol

1. Disable third-party features that automatically import or spawn MCP servers from other agent configuration directories.
2. Run the audit against every Codex home used by Desktop, native CLI, WSL, or isolated workers.
3. When findings exist, checkpoint active Codex work and run the reversible remediation.
4. Restart the affected third-party MCP client so it discards its previously discovered server list.
5. Run the audit again and require `safe_for_third_party_discovery: true`.
6. If Codex regenerates the cache entry, keep third-party auto-import disabled and rerun the guard before using that third-party client.
7. Do not replace the relative command with an assumed path unless that path is verified on the current host.

## Boundaries

This guard does not:

- Enable Computer Use
- Start an MCP server
- Add a model provider or gateway
- Expose secrets to a local process
- Modify enabled MCP server definitions
- Delete backups automatically

The safe default is for each operator tool to use an explicit, independently reviewed MCP server allowlist rather than scanning all agent caches and configuration files.
