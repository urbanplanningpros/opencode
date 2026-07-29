# Codex collaboration-message replay boundary

## Trigger

Use this protocol when a Codex client serializes, stores, replays, forwards, or audits collaboration tool calls for:

- `spawn_agent`
- `send_message`
- `followup_task`

Upstream Codex now preserves `encrypted_function_args` on function-call records. An explicitly present empty list is a semantic marker: the collaboration arguments must be delivered as a structured plaintext agent message. A non-empty list retains encrypted delivery. Omitting the field is not equivalent to preserving an empty list.

## Required replay evidence

Before replaying a collaboration call, capture:

```json
{
  "route": "direct_openai",
  "tool": "spawn_agent",
  "arguments_sha256": "<canonical-argument-hash>",
  "original_marker": {
    "field_present": true,
    "item_count": 0
  },
  "replay_marker": {
    "field_present": true,
    "item_count": 0
  },
  "delivery": "structured_plaintext_agent_message",
  "lineage": {
    "root_turn_id": "root-turn",
    "turn_id": "child-turn",
    "parent_turn_id": "authoritative-parent",
    "expected_parent_turn_id": "authoritative-parent",
    "authorized": true
  },
  "logging": {
    "tool_arguments_redacted": true,
    "communication_payload_redacted": true,
    "raw_arguments_persisted": false
  },
  "downstream": {
    "non_openai_metadata_forwarded": false
  }
}
```

Run:

```bash
node scripts/operator/codex-collaboration-message-replay-guard.mjs \
  --input /approved/task/collaboration-message-evidence.json \
  --json
```

Exit `0` permits the bounded replay. Exit `64` rejects it. Exit `2` reports malformed evidence.

## Serialization rules

```text
encrypted_function_args field present and empty
→ preserve the empty list exactly
→ deliver structured plaintext agent message
→ redact arguments from tool and communication logs

field present and non-empty
→ preserve the list and encrypted delivery

field absent
→ do not synthesize an empty list
→ retain encrypted delivery semantics
```

Do not use serializers, database defaults, schema cleaners, or JSON canonicalizers that remove empty arrays from this field. A dropped empty list changes the transport semantics of the replayed collaboration message.

## Authority boundary

Transport semantics do not grant authority.

Before accepting or executing the collaboration message:

```text
Verify canonical argument hash
→ verify tool is exactly allowlisted
→ verify parent_turn_id matches the recorded parent
→ verify the parent belongs to the authoritative root turn
→ verify the task has the requested read or write authority
→ dispatch once
→ verify any external write independently
```

A missing or mismatched parent-turn relationship blocks replay. Do not infer lineage from timestamps, transcript order, task names, or the currently visible thread.

## Logging and retention

Plaintext collaboration arguments must not appear in:

- tool-call logs;
- communication logs;
- operator telemetry payloads;
- task summaries intended for broad retention;
- error messages or crash reports.

Store only the canonical argument hash, tool identity, lineage, delivery mode, redaction attestation, operation ID, and independently verified result receipt.

## Compatibility boundary

The provider-specific marker belongs only to the explicitly pinned direct OpenAI route. Do not forward it to another provider, gateway, automatic model selector, imported session, connector bridge, or deployment service.

If a connected runtime does not understand the marker:

```text
Do not replay the collaboration call through that runtime
→ preserve the original task manifest and argument hash
→ start a fresh direct-OpenAI task with the same authorized lineage
→ reconstruct the bounded message from approved task state
→ reconcile uncertain external writes before continuing
```

## Promotion canary

Before promoting a runtime that implements this behavior:

1. Serialize and replay an empty `encrypted_function_args` list and confirm it remains present and empty.
2. Confirm the collaboration payload arrives as a structured plaintext agent message.
3. Confirm a non-empty marker retains encrypted delivery.
4. Confirm an absent field does not become an empty field.
5. Confirm plaintext arguments are absent from tool logs, communication logs, telemetry, and failure output.
6. Confirm a mismatched `parent_turn_id` blocks replay.
7. Confirm an external write is not marked complete until destination verification succeeds.
8. Confirm provider-specific metadata is not emitted outside the direct OpenAI route.
