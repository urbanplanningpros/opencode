# Codex cross-platform terminal path boundary

Upstream Codex changes `#35850` and `#35851` preserve foreign-platform working directories in background-terminal listings and normalize supported Windows device-namespace drive and UNC aliases into canonical path URIs.

## Authority rule

A background terminal `cwd` is provenance and display data. It does not grant local filesystem authority.

- POSIX, Windows drive, and UNC paths may be displayed on any host.
- A path from a different platform must not be converted into a host-native absolute path.
- `\\?\\D:\\...` and `\\.\\D:\\...` aliases normalize to the canonical drive path and `file:///D:/...` URI.
- `\\?\\UNC\\server\\share\\...` and `\\.\\UNC\\server\\share\\...` normalize to canonical UNC paths and hosted `file://server/share/...` URIs.
- Reserved devices, volume identifiers, malformed UNC paths, localhost aliases, relative paths, and other ambiguous namespaces remain opaque.
- Opaque or foreign paths must never satisfy an allowed-root, repository-containment, deployment-root, attachment-root, or secret-access check.
- Local authority requires a separately verified path on the app-server host.

## Guard

Capture the app-server terminal listing as bounded evidence and mark each use as display-only or as a request for local filesystem authority:

```json
{
  "host_platform": "linux",
  "terminals": [
    {
      "item_id": "item-123",
      "cwd": "C:\\repo",
      "purpose": "display_only"
    },
    {
      "item_id": "item-456",
      "cwd": "/srv/upp/repo",
      "purpose": "local_filesystem_authority",
      "local_authority_verified": true,
      "expected_normalized_uri": "file:///srv/upp/repo"
    }
  ]
}
```

Run:

```bash
node scripts/operator/codex-terminal-path-provenance-guard.mjs \
  --input /approved/task/background-terminal-paths.json \
  --json
```

Exit codes:

```text
0  evidence admitted
64 path provenance or authority boundary rejected
2  malformed evidence or invocation
```

## Client compatibility

App-server clients should accept `ThreadBackgroundTerminal.cwd` as a path string whose convention may differ from the host. Do not reject the entire terminal list because one `cwd` is foreign. Preserve the original string and the inferred convention in operator evidence.

Before using a listed working directory for a local action:

1. Resolve the task and terminal ownership independently.
2. Verify the path on the app-server host rather than trusting the listing string.
3. Canonicalize aliases before containment checks.
4. Reject opaque namespaces for local authority.
5. Reconfirm allowed-root containment and symlink policy.
6. Preserve operation and idempotency identifiers for any resulting write.

These upstream changes are not yet a validated stable release. Keep the compatibility guard at the operator boundary until the installed Codex version passes cross-platform terminal-listing and namespace-path canaries.
