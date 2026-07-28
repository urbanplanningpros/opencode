# Windows spreadsheet junction continuity

Codex spreadsheet workflows may expose a loader-managed shared `node_modules` directory through a Windows junction. Never include that junction in `Move-Item`, `Copy-Item`, archive creation, recursive cleanup, or a multi-path file operation. A cross-volume move can dereference the junction and split or remove the shared dependency runtime.

## Required layout

Keep the conversation-specific spreadsheet workspace on the same filesystem volume as the loader-provided runtime. Prefer a disposable work directory on that volume rather than placing a dependency junction inside a workbook or repository on another drive.

## Inspect the exact junction

```powershell
$env:OPERATOR_SPREADSHEET_SHARED_RUNTIME_ROOT = 'C:\approved\shared-runtime'

node scripts/operator/codex-spreadsheet-junction-guard.mjs `
  --path 'C:\temp\spreadsheet-work\node_modules' `
  --json
```

Exit `0` means the approved target and workspace are on the same volume. Exit `75` means the junction is valid but the workspace is cross-volume and must not be used for a spreadsheet build. Exit `64` means the path, link type, or target failed policy validation.

## Remove only the link

Use the confirmation token from the current inspection result:

```powershell
node scripts/operator/codex-spreadsheet-junction-guard.mjs `
  --path 'C:\temp\spreadsheet-work\node_modules' `
  --unlink `
  --confirm 'UNLINK_SPREADSHEET_JUNCTION:<sha256>' `
  --json
```

The guard revalidates the link immediately before calling the exact non-recursive unlink operation, verifies the link is gone, and verifies the shared target still exists. It never moves, copies, archives, or recursively deletes the dependency tree.

## Recovery after runtime damage

1. Stop admitting new spreadsheet builds to the affected shared runtime.
2. Preserve the interrupted command evidence and both directory locations.
3. Do not merge the split directories or run broad cleanup commands.
4. Route new workbook work through a fresh approved runtime and same-volume workspace.
5. Repair or reinstall the damaged loader-managed bundle through its supported lifecycle.
6. Run a disposable `@oai/artifact-tool` import canary before releasing queued spreadsheet jobs.

Keep unrelated Codex, build, connector, and automation work operating through unaffected approved OpenAI or authorized local routes.
