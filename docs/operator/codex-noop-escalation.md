# Codex no-op escalation guard

## Boundary

Upstream `openai/codex#35974`, filed July 29, 2026, documents Codex exposing `require_escalated` in shell-like tool schemas even when the effective profile is already `danger-full-access` / `PermissionProfile::Disabled` with unrestricted filesystem and enabled network access.

In that state, `require_escalated` cannot widen execution authority. A successful retry can still make a transient failure look as though sandbox escalation fixed it, creating false diagnostics and unnecessary reusable approval rules.

## Operating rule

When the effective execution profile is already unrestricted:

1. Reject `sandbox_permissions=require_escalated` as a no-op capability request.
2. Do not store a reusable `prefix_rule` for that request.
3. Classify the underlying failure separately as transient, deterministic, policy-related, dependency-related, or external.
4. Preserve task state, repository SHA, diff hash, operation IDs, and idempotency keys.
5. Reconcile uncertain external writes before retrying.
6. Retry the same idempotent command at most once through the same pinned approved OpenAI route, without the no-op escalation field.
7. Use the explicitly authorized local route when the direct route remains unavailable.
8. Keep ordinary execution-policy approval for intrinsically dangerous commands, but describe it as command approval rather than a sandbox bypass.

Do not introduce an automatic model selector, gateway, Copilot route, Bedrock, Vertex, or an excluded provider to recover the command.

## Evidence guard

```bash
node scripts/operator/codex-noop-escalation-guard.mjs \
  --input /approved/task/codex-noop-escalation-evidence.json \
  --json
```

Expected evidence shape:

```json
{
  "effective": {
    "sandboxMode": "danger-full-access",
    "permissionProfile": "disabled",
    "filesystem": "unrestricted",
    "network": "enabled"
  },
  "toolCall": {
    "sandboxPermissions": "require_escalated",
    "justification": "retry with unrestricted network",
    "prefixRule": ["nix", "develop"]
  },
  "retry": {
    "planned": true,
    "uncertainWritesReconciled": true
  },
  "routing": {
    "provider": "OpenAI",
    "selector": "pinned",
    "fallback": "explicitly-authorized-local"
  }
}
```

Exit behavior:

```text
0   request is compatible with the effective permission profile
75  no-op escalation detected; apply bounded remediation
64  prohibited route or unsafe retry detected
2   malformed evidence
```

## Promotion condition

Remove this compatibility guard only after a stable Codex release proves that:

- unrestricted profiles do not advertise `require_escalated`;
- stale escalation requests are rejected or safely normalized at the handler boundary;
- ordinary risky-command approvals remain available without claiming a sandbox bypass;
- restricted profiles still expose escalation only when it can materially widen permissions.
