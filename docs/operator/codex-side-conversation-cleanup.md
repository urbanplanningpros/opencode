# Codex Side-Conversation Cleanup Boundary

Stable Codex CLI `0.146.0` introduced side conversations, but upstream merged `openai/codex#35887` after the stable release.

The post-release correction:

- removes an abandoned side conversation from local TUI state immediately;
- interrupts and unsubscribes it in the background;
- retries interruption with the actual active turn when cleanup races a turn change;
- ignores late notifications from the abandoned thread;
- rejects late server requests and approval requests from that abandoned thread.

## Production rule

Keep collaboration and side-conversation features disabled on stable `0.146.0`. The existing `codex-0146-safe-launch.mjs` release guard already disables the collaboration surface, so no broad workflow pause is required.

Do not promote side conversations until a stable Codex release contains commit:

```text
d06c7ac055920c7cb140c25ebda3f3db20197b45
```

and passes this canary:

1. Start a bounded read-only side conversation.
2. Begin a request that would produce a notification or approval prompt.
3. Switch away and close the side conversation while the request is active.
4. Confirm the local side-thread state disappears immediately.
5. Confirm the server receives interruption and unsubscription.
6. Send a late notification and confirm it is ignored.
7. Send a late approval or server request and confirm it is explicitly rejected.
8. Confirm no connector, deployment, billing, email, or customer-facing write can inherit authority from the abandoned thread.
9. Confirm the parent task manifest and active thread remain intact.

## Unfixed-runtime fallback

```text
Keep collaboration disabled
→ continue the authoritative task in the primary guarded thread
→ use separate provider-neutral manifests for approved parallel local analysis
→ preserve operation IDs and idempotency keys
→ independently reconcile every uncertain external write
```

Do not treat switching threads, removing a sidebar entry, or an interrupt call returning as proof that the abandoned thread stopped. Authority returns only after its late events and requests are proven inert.
