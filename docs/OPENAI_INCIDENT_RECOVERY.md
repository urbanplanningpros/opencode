# OpenAI Incident Recovery Guard

## Purpose

Prevent rapid route promotion when OpenAI, the API platform, ChatGPT, or Codex repeatedly enters and exits degraded status.

## Flapping definition

Treat the provider as flapping when either condition is true:

- Two OpenAI incidents affecting the API or Codex begin within a two-hour window.
- A newly resolved incident is followed by another affected-service incident within two hours.

## Required routing

While flapping:

```text
Approved local route
→ 10% read-only OpenAI canary
→ OpenAI only after the local route cannot complete the task
```

Use the `openai_degraded` profile. Local execution remains network-denied by default and receives no production secrets.

## Recovery hold

Do not restore OpenAI as the primary route until all conditions pass:

1. At least two hours have elapsed since the most recent OpenAI incident was marked resolved.
2. No new affected-service incident has appeared during that period.
3. Ten consecutive read-only OpenAI canaries have succeeded.
4. Two controlled idempotent OpenAI writes have succeeded and their target state has been verified.
5. No duplicate, truncated, missing, stale, or malformed tool results were observed.
6. The approved local rollback route remains healthy.

If another incident starts during the hold, restart the two-hour clock from the next official resolution time.

## Circuit-breaker settings

During a flapping window, use a minimum 15-minute route cooldown. Do not interpret isolated successful calls as provider recovery.

## Host configuration

Repository defaults apply only when a host has no explicit override. During the hold, remove stale overrides or use:

```bash
export OPERATOR_INCIDENT_PROFILE=openai_degraded
```

After recovery criteria pass, remove the override and restore the repository default to `continuity`.
