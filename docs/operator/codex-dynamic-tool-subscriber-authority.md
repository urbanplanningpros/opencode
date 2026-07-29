# Codex Dynamic-Tool Subscriber Authority

## Risk boundary

Codex app-server can have multiple connections subscribed to one thread. In affected builds, a dynamic-tool request may be broadcast to every subscriber with one JSON-RPC request ID, while the first response or error resolves the shared callback. A non-handler subscriber can therefore report failure before the authorized handler returns success. For mutating tools, durable state may change even though the caller sees an error, and an ordinary retry can duplicate the operation.

## Production rule

A dynamic tool has exactly one authoritative responder.

Until the app server targets dynamic-tool requests to one connection and binds callbacks to that connection, use exclusive single-subscriber compatibility mode:

1. Persist the task, operation ID, idempotency key, canonical arguments, and expected result before dispatch.
2. Attest that exactly one connection is subscribed to the tool-bearing thread.
3. Attest that the subscriber owns the handler and has explicit authority for the tool.
4. Prevent Desktop, remote-control, observer, reconnect, or secondary app-server clients from resuming the thread during the operation.
5. Run the admission guard before dispatch.
6. Verify mutating results independently before marking the queue record complete.
7. Treat a caller-visible failure with a present or unknown durable side effect as an uncertain write. Reconcile before any retry.

Run:

```bash
node scripts/operator/codex-dynamic-tool-subscriber-guard.mjs \
  --input /approved/task/dynamic-tool-subscriber-evidence.json \
  --json
```

Exit codes:

```text
0  admitted
64 policy, authority, provenance, or routing rejection
75 compatibility failure or reconciliation required
2  malformed evidence
```

## Patched app-server promotion

Multi-subscriber operation is allowed only when all of the following are proven:

- One subscribed connection is the authorized dynamic-tool handler.
- The request is sent only to that target connection.
- The pending callback is keyed by request ID and target connection ID.
- Responses and errors from every other connection are rejected.
- Non-target subscribers explicitly have no response authority.
- Reconnect replay restores the request only when exactly one capable target exists.

Thread notifications may remain broadcast; authority-bearing dynamic-tool requests may not.

## Continuity route

When exclusive ownership cannot be guaranteed:

```text
checkpoint task state
→ block only the dynamic-tool dispatch
→ execute through the approved local action dispatcher or a fresh single-subscriber app-server thread
→ preserve the original operation ID and idempotency key
→ independently verify the target state
```

Do not route through model gateways, automatic model selection, Bedrock, Vertex, Copilot routing, or excluded-provider infrastructure.
