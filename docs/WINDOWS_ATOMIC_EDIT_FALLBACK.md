# Windows `apply_patch` continuity fallback

## Trigger condition

Use this path only when native Windows Codex reports a sandbox compatibility failure such as:

```text
windows unelevated restricted-token sandbox cannot enforce split writable root sets directly
helper_unknown_error
setup refresh had errors
```

These errors indicate that the Windows sandbox cannot enforce the writable-root shape supplied to `apply_patch`. They are not evidence that the requested patch is malformed.

Do not repeatedly retry `apply_patch`, disable the sandbox, switch to full access, or move temporary files into a system-wide temporary directory.

## Approved fallback

The atomic edit helper replaces the complete target file through a temporary file created beside the target. It requires the caller to prove the file version being replaced by supplying its SHA-256 hash.

Prepare an edit request:

```bash
TARGET="packages/example/src/file.ts"
EXPECTED=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$TARGET")
CONTENT=$(node -e 'process.stdout.write(Buffer.from(process.argv[1],"utf8").toString("base64"))' "$(cat replacement-file.ts)")

node -e 'process.stdout.write(JSON.stringify({
  path: process.argv[1],
  expected_sha256: process.argv[2],
  content_base64: process.argv[3]
}))' "$TARGET" "$EXPECTED" "$CONTENT" \
  | bun operator:atomic-edit
```

For a new file, the request must contain:

```json
{
  "path": "relative/path/new-file.ts",
  "expected_sha256": "missing",
  "allow_create": true,
  "content_base64": "..."
}
```

## Enforcement

The helper:

- Allows writes only beneath the repository root or `OPERATOR_ALLOWED_WRITE_ROOTS`.
- Rejects symbolic-link targets.
- Rejects stale edits when the expected hash does not match.
- Defaults to a 10 MiB maximum replacement size through `OPERATOR_ATOMIC_EDIT_MAX_BYTES`.
- Writes the temporary file in the target directory, avoiding disjoint system temporary roots.
- Preserves the existing file mode.
- Verifies the final content hash before returning `verified=true`.

## Completion checks

After a successful edit:

```bash
git diff -- "$TARGET"
```

Then run the narrowest relevant formatter, type check, and test suite. Save the helper's JSON result with the task evidence.

If the helper reports a stale hash or an out-of-root path, do not override it. Re-read the current file, regenerate the intended replacement, and repeat the review process from the new state.
