# Codex Windows voice-session continuity

This protocol contains the Windows Desktop `26.721.4979.0` native voice-shortcut failure reported in `openai/codex#36050` on July 29, 2026.

The reported sequence created a separate projectless realtime-voice task, then dispatched an archive request against the pre-existing long-running source task. The source history remained in the backend archive and was recoverable, but disappeared from normal task history until manually unarchived.

The goal is to isolate only the affected native voice accelerator while keeping text-based Codex work, approved direct OpenAI execution, and explicitly authorized local or Linux continuity routes operating.

## Admission command

```bash
node scripts/operator/codex-windows-voice-session-continuity-guard.mjs \
  --input /approved/task/windows-voice-session-evidence.json \
  --json

node scripts/operator/codex-windows-voice-session-continuity-guard-selftest.mjs
```

Exit codes:

```text
0   source-task and voice-shortcut continuity verified
75  bounded recovery or shortcut isolation required
64  duplicate/replacement work or prohibited routing detected
2   malformed invocation or evidence
```

## Preventive boundary

For authority-bearing tasks on Windows Desktop build `26.721.4979.0`:

```text
native Toggle voice chat shortcut
→ disabled, removed, or otherwise isolated from the operator profile
```

Do not invoke realtime voice from a long-running project task. When voice is needed, start it only from a separate disposable, projectless task after preserving the authoritative source-task checkpoint.

The checkpoint must contain:

```text
source thread ID
operation ID and idempotency key
repository and commit SHA
current diff SHA-256
completed-step ledger
pending approvals
external-write reconciliation state
exact next unfinished action
```

This does not require stopping normal Codex text work.

## Recovery after accidental invocation

When the shortcut creates a voice task or the source task disappears:

```text
do not continue work in the voice-created task
→ do not create a replacement task
→ record the source and voice thread IDs
→ open Archived tasks
→ locate the exact source thread ID
→ unarchive the source thread
→ verify repository, approval, and external-write state
→ reconcile uncertain writes
→ continue the exact unfinished action in the same source thread
```

An approved local or Linux executor may continue the exact unfinished command only after the source task and external mutation state are reconciled. It must not create a new model handoff or replay a possibly completed operation.

If the exact source thread cannot be found in normal history or Archived tasks, pause only that source-task continuation. Preserve the checkpoint and resume when the source identity and durable state are recovered or a corrected stable build is available. Other workflows continue normally.

## Required evidence

```json
{
  "task_id": "task-source-123",
  "operation_id": "operation-123",
  "platform": "windows",
  "desktop_build": "26.721.4979.0",
  "authority_bearing_task": true,
  "uncertain_writes_reconciled": true,
  "continuation_route": "same_source_thread",
  "voice_shortcut": {
    "invoked": true,
    "source": "native_accelerator",
    "native_shortcut_enabled": false,
    "native_shortcut_isolated": true,
    "source_thread_id": "thread-source-123",
    "voice_thread_id": "thread-voice-456",
    "voice_thread_projectless": true,
    "source_archive_requested": true,
    "archive_target_thread_id": "thread-source-123",
    "source_archived": true,
    "source_visible_in_normal_history": false,
    "source_history_found_in_archive": true,
    "source_unarchived": true,
    "source_thread_identity_verified": true,
    "source_state_verified": true,
    "duplicate_work_started": false,
    "replacement_thread_used": false
  }
}
```

## Resume condition

Restore native voice-shortcut authority to long-running project tasks only after a corrected stable Desktop build passes at least 25 consecutive disposable canaries proving:

```text
voice creates or uses the intended thread
source project task remains visible
source archive state does not change
source task identity and history remain intact
no duplicate task or operation is created
pending approvals and repository state remain attached to the source task
```

No excluded provider, model gateway, automatic selector, Amazon Bedrock, Google Vertex, or GitHub Copilot routing is permitted by this guard.
