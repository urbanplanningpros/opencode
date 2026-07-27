# Dynamic MCP tool continuity

## Trigger

Use this protocol when a trusted MCP server declares `tools.listChanged = true`, successfully loads a toolset, emits `notifications/tools/list_changed`, but Codex Desktop does not expose the newly available tools.

This is a client-registry compatibility failure. It is not evidence that the MCP server failed or that the newly loaded tool is unauthorized.

## Production rule

Business-critical Codex tasks must not depend on runtime changes to the Desktop MCP tool registry until the affected client is fixed and validated.

Prefer one of these routes:

1. Configure the approved MCP server to expose the complete required toolset at process startup.
2. If startup exposure is unavailable, execute one bounded dynamic call through the local one-shot executor in this repository.

Do not broaden the server tool allowlist, switch to a model gateway, disable connector controls, or import another agent runtime to make the tool visible.

## One-shot local route

The executor initializes one explicitly approved stdio MCP server, runs bounded preload calls, requests a fresh `tools/list`, verifies that the target tool is present, calls it, and terminates the server process tree.

The upstream command is host-controlled and is never accepted from the queued payload:

```bash
export OPERATOR_MCP_UPSTREAM_COMMAND='["/absolute/path/to/approved-mcp-server","--stdio"]'
export OPERATOR_MCP_ALLOWED_TOOLS='["load_toolset","get_board_info"]'
export OPERATOR_ACTION_EXECUTOR_COMMAND='["node","scripts/operator/mcp-dynamic-tool-local.mjs"]'
```

Queue a read operation:

```bash
bun operator:queue \
  --action mcp_dynamic_tool_call \
  --operation-id pcb-board-read-001 \
  --idempotency-key pcb-board-read-001-v1 \
  --payload '{
    "mode":"read",
    "preload_calls":[
      {"name":"load_toolset","arguments":{"name":"pcb_board"}}
    ],
    "tool_call":{"name":"get_board_info","arguments":{}}
  }'

bun operator:process
```

For a write, the payload must include a separate verification tool and an expected text fragment from the post-write state:

```json
{
  "mode": "write",
  "preload_calls": [
    {"name": "load_toolset", "arguments": {"name": "pcb_board"}}
  ],
  "tool_call": {
    "name": "set_board_size",
    "arguments": {"width": 100, "height": 80}
  },
  "verification_call": {
    "name": "get_board_info",
    "arguments": {}
  },
  "verification": {
    "expect_text_includes": "100"
  }
}
```

The queue marks the operation completed only when the executor returns `verified=true`. A timeout, process failure, tool error, missing dynamic tool, or failed post-write check moves the operation to reconciliation and is not automatically replayed.

## Security boundaries

- The stdio command must be an absolute, reviewed local route supplied through `OPERATOR_MCP_UPSTREAM_COMMAND`.
- `OPERATOR_MCP_ALLOWED_TOOLS` is mandatory and exact; an empty allowlist is invalid.
- Commands containing prohibited provider or gateway identifiers are rejected.
- Shell interpolation is not used.
- Tool-list pagination, message size, preload count, stderr capture, and request duration are bounded.
- Server-initiated requests are denied by the shim.
- Write operations require a separate post-write read and explicit expected evidence.
- Secrets remain in the local executor environment and must not be placed in prompts, task manifests, queue payloads, repositories, or logs.

## Recovery

When Desktop fails to refresh its tools:

```text
Checkpoint task state
→ preserve operation and idempotency identifiers
→ do not keep calling the unavailable Desktop tool
→ route the exact call through the approved local executor
→ verify the result or destination state
→ continue the authoritative task from the durable manifest
```

Only the affected connector path is restricted. Unrelated builds, analysis, repository work, and verified connectors continue through the approved direct OpenAI or local routes.

## Upstream validation before restoring Desktop dynamic tools

Resume direct dynamic-tool use only after a fixed stable client passes all of the following:

1. The server declares `tools.listChanged = true`.
2. A toolset load emits exactly one list-change notification.
3. Codex requests a refreshed `tools/list`.
4. Added tools become callable in the same task.
5. Removed tools become unavailable.
6. Ten read-only dynamic calls pass.
7. Two idempotent writes pass with independent post-write verification.
8. Restart and task resume preserve the intended tool registry without importing unapproved servers.
