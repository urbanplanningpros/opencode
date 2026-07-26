# Codex Attestation and Compaction HTTP-SSE Recovery

## Trigger condition

Use this recovery route when a long-running Codex Desktop or app-server thread cannot take another turn and logs show one or more of:

```text
run_pre_sampling_compact
run_auto_compact{reason=ContextLimit phase=PreTurn}
attestation generation request timed out
Failed to run pre-sampling compact
IO error broken pipe
could not find callback for Integer(...)
```

Affected reports show the desktop attestation IPC response arriving after the current 100 ms deadline. The failed compaction leaves the thread over its context limit, so later turns can repeat the same failure.

## Approved recovery route

Checkpoint the task objective, acceptance criteria, decisions, changed files, operation IDs, and continuation prompt outside the Codex thread. Then launch the guarded CLI with OpenAI Responses WebSockets disabled:

```bash
bun operator:codex-http-recover -- exec --ephemeral -
```

Equivalent environment-controlled invocation:

```bash
export OPERATOR_CODEX_FORCE_HTTP_SSE=1
bun operator:codex-safe -- exec --ephemeral -
```

The launcher injects:

```text
-c model_providers.openai.supports_websockets=false
```

This keeps the approved direct OpenAI provider but routes Responses streaming through HTTP-SSE, avoiding the desktop WebSocket attestation handshake during recovery.

## Recovery sequence

1. Preserve provider-neutral task state before retrying.
2. Do not replay uncertain connector or customer-facing writes.
3. Start the affected task through `operator:codex-http-recover`.
4. Allow the required pre-turn compaction to complete.
5. Verify the thread or replacement task is below its context limit and can accept a normal turn.
6. Reconcile all external writes by operation and idempotency keys.
7. Return to `operator:codex-safe` without HTTP-SSE recovery after the thread is healthy.

## Guardrails

- The recovery launcher rejects attempts to set `model_providers.openai.supports_websockets=true` during recovery.
- It retains the existing `remote_plugin`, `code_mode`, and `code_mode_only` blocks.
- It does not route through model gateways, automatic provider selection, excluded providers, Bedrock, or Vertex.
- Do not make the HTTP-SSE override permanent unless the failure remains reproducible; normal guarded execution may use the validated configured transport.
- Do not delete or rewrite the affected session as the first response. Preserve it for diagnostics and recover from the provider-neutral continuation state.

## Removal condition

Remove this temporary recovery requirement only after a stable Codex release raises or otherwise fixes the attestation deadline, the original long-thread reproduction compacts successfully over WebSockets, and ten read-only long-session canaries complete without attestation timeout or repeated compaction failure.
