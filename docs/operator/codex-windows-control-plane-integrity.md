# Codex Windows control-plane integrity

This protocol addresses two Windows Codex Desktop failure boundaries reported on July 29, 2026:

- `openai/codex#35910`: deeply nested loose checkpoint refs can exceed Windows-safe path lengths and break Git clients that enumerate `.git/refs`.
- `openai/codex#35906`: MCP form-elicitation approval messages can collapse line breaks in the Desktop approval UI, obscuring the separation between target, risk, reason, and exact operation.

## Operating boundary

These findings do not require stopping unrelated Codex, Git, connector, or VPS work. They require isolating only the affected Windows Desktop operation.

Approved routes remain:

1. Guarded direct OpenAI execution.
2. The explicitly authorized local route.
3. VPS-controlled connector executors with provider-neutral task state, idempotency keys, and independent verification.

Do not introduce model gateways, automatic model selection, GitHub Copilot routing, Amazon Bedrock, Google Vertex, or excluded-provider state.

## Checkpoint-ref preflight

Run from the repository root before admitting a Windows Desktop project with substantial Codex history:

```powershell
node scripts/operator/codex-windows-checkpoint-ref-guard.mjs `
  --repo $PWD `
  --max-path-chars 240
```

Exit codes:

```text
0   no affected loose checkpoint ref was found
75  one or more loose checkpoint paths reached the configured limit
64  unsafe or symlinked Git metadata was detected
2   malformed invocation or repository inspection failure
```

When exit `75` occurs:

1. Stop Codex Desktop and all other Git writers for that repository.
2. Preserve `.git/packed-refs` when present and back up `.git/refs/codex/turn-diffs/checkpoints`.
3. Run `git fsck --no-reflogs` and preserve the output.
4. Run:

```powershell
git pack-refs --all --prune
```

5. Run the guard and `git fsck --no-reflogs` again.
6. Verify the Git client can enumerate branches and labels.

Packing refs is a targeted compatibility action. Do not delete Codex refs, rewrite their targets, remove `.git`, or move the repository merely to hide the path-length condition.

## MCP approval-display boundary

A Desktop approval dialog is not authoritative when its rendered message does not preserve the source message structure. For any connector, database, deployment, billing, CRM, email, or customer-facing write, require a separate machine-readable approval receipt bound to:

- operation ID;
- idempotency key;
- target asset;
- risk level;
- exact operation or command;
- canonical payload SHA-256.

Run:

```bash
node scripts/operator/codex-mcp-approval-display-guard.mjs \
  --input /approved/task/mcp-approval-evidence.json \
  --json
```

If the Desktop rendering collapses the source line breaks, withhold authority from that dialog only. Render the exact source message and structured fields in an independent approved surface, verify the payload hash, create the short-lived approval receipt, and rerun the guard. Continue unrelated workflows normally.

After execution, independently read the destination state. A caller-visible failure or ambiguous UI response must enter reconciliation and must not be blindly retried.

## Promotion criteria

Restore Windows Desktop authority for these surfaces only after:

1. checkpoint refs remain below the approved loose-path threshold through two real task cycles;
2. the Git client enumerates all expected refs without path errors;
3. MCP approval messages preserve LF and CRLF structure in two disposable canaries;
4. exact payload hashes match the approved receipts;
5. two idempotent test writes complete and verify independently;
6. rollback to the guarded direct OpenAI or authorized local route remains available.
