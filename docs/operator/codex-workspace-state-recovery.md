# Codex workspace and state recovery boundary

This protocol addresses three post-release failure boundaries reported against Codex Desktop and its bundled runtime on July 29, 2026:

- `openai/codex#35914`: Windows sandbox setup can hang for minutes when a workspace is on a Google Drive virtual filesystem because the drive rejects the ACL operation used by `codex-windows-sandbox-setup.exe`.
- `openai/codex#35912`: a completed Codex Security Deep scan can remain stuck at report finalization after a workspace snapshot or continuation-owner mismatch, even though the canonical findings bundle is intact and valid.
- `openai/codex#35911`: automatic compaction can return a transient remote-capacity error and incorrectly instruct the operator to change models even though the same task later recovers without a model change.

These issues do not justify pausing unrelated business-critical operations. Isolate the affected workspace, scan finalization, or compaction event and continue through the guarded direct OpenAI route or an explicitly authorized local executor.

## Windows workspace preflight

Before admitting Windows Desktop write authority, run:

```powershell
node scripts/operator/codex-windows-workspace-filesystem-guard.mjs `
  --workspace $PWD `
  --json
```

The guard admits only a local fixed NTFS/ReFS filesystem with no recorded sandbox ACL failure. A virtual, cloud-backed, network, unknown, or ACL-incompatible drive exits `75`.

When exit `75` occurs:

1. Stop retrying the hanging Desktop write.
2. Preserve the task manifest, operation ID, idempotency key, current diff, and tool evidence.
3. Reconcile any write whose outcome is uncertain.
4. Move or mirror the repository to a local NTFS/ReFS workspace.
5. Continue through guarded Codex CLI/Desktop or the approved VPS/local executor.
6. Verify the resulting files and Git state.
7. Synchronize ordinary project files back to the cloud drive only after verification.

Do not disable Windows integrity controls, broaden ACLs across the virtual drive, or repeatedly launch the sandbox helper.

## Security scan finalization recovery

Create a machine-readable evidence file containing:

- `mode: security_scan_finalization`;
- operation ID and idempotency key;
- completion status for discovery, validation, write-ups, and artifacts;
- every canonical artifact path and SHA-256;
- expected and current workspace snapshot SHA-256 values;
- continuation-owner status.

Run:

```bash
node scripts/operator/codex-state-recovery-guard.mjs \
  --input /approved/task/security-scan-finalization.json \
  --json
```

If canonical artifacts validate but the snapshot or owner does not match, exit `75` means the completed work is recoverable. Preserve the bundle, reclaim the original continuation, and restore or rebind the exact snapshot before adopting or finalizing the existing artifacts. Do not repeat discovery, validation, or report generation.

If artifact hashes do not match, exit `64` blocks finalization until provenance is reconciled.

## Compaction capacity recovery

For a remote-compaction capacity error, persist evidence containing:

- `mode: compaction_capacity`;
- the explicitly selected approved OpenAI model;
- the exact error;
- failure count;
- confirmation that task state is checkpointed;
- confirmation that uncertain writes are reconciled;
- `allow_automatic_model_change: false`.

Run the same state guard. On the first failure it returns exit `75` with a bounded same-model retry. On a repeated failure it directs the operator to start a fresh guarded turn from the persisted checkpoint or use the explicitly authorized local route.

Do not use an automatic selector, model gateway, GitHub Copilot route, Amazon Bedrock, Google Vertex, or excluded-provider runtime, connector, session, memory, or handoff.

## Exit codes

```text
0   verified operation may continue
75  bounded compatibility recovery or reroute required
64  integrity, authority, or prohibited-routing failure
2   malformed invocation or evidence
```

## Verification

Run:

```bash
node scripts/operator/codex-workspace-state-recovery-selftest.mjs
```

Production promotion still requires:

1. a disposable Windows local-filesystem canary;
2. a disposable virtual-drive rejection canary;
3. artifact adoption/finalization without repeating scan work;
4. one transient compaction recovery on the same selected model;
5. a repeated-failure resume from a persisted checkpoint;
6. independent verification of every external write;
7. rollback to the prior guarded route.
