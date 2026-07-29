# External Email Send Approval Boundary

## Purpose

Planning, drafting, preparing, sequencing, or automating outreach does not authorize delivery. Every Gmail write must have a separate, short-lived approval receipt bound to the exact final message payload.

The approved VPS route is:

```text
Draft or plan
→ render the final email approval envelope
→ human/root approval of the exact hash
→ queue one gmail_send operation
→ execute through gmail-send-approved-local.mjs
→ independently verify the stored Gmail message
```

Do not expose the raw `gmail-send-local.mjs` executor as `OPERATOR_ACTION_EXECUTOR_COMMAND` in production. The approved wrapper is the only Gmail delivery entry point.

## Receipt directory

Create a root-controlled directory outside the repository and operator state visible to models:

```bash
install -d -m 0755 -o root -g root /var/lib/upp-operator/email-approvals
export OPERATOR_EMAIL_APPROVAL_ROOT=/var/lib/upp-operator/email-approvals
export OPERATOR_EMAIL_APPROVAL_OWNER_UID=0
export OPERATOR_EMAIL_APPROVAL_MAX_SECONDS=900
```

Approval files are root-owned, readable by the executor, and never group- or world-writable. They contain hashes and authority metadata, not the email body.

## Preview the exact message

Prepare a queue-record JSON file containing one `gmail_send` operation. The payload supports only:

- `to`, `cc`, and `bcc`
- `subject`
- `body_text` or the legacy `body` alias
- `body_html`
- `attachments`
- `approval_receipt`

Sequence, scheduling, follow-up, or other unknown fields are rejected.

Preview:

```bash
node scripts/operator/email-send-approval.mjs \
  --input /approved/task/gmail-send-record.json
```

The command prints the normalized recipients, full bodies, attachment paths, sizes, and SHA-256 hashes, followed by a confirmation token:

```text
APPROVE_EMAIL:<payload-sha256>
```

Review the complete preview. Do not approve from a summary, prior draft, or model statement.

## Create the receipt

Run the approval step as root or through an isolated approval service:

```bash
sudo OPERATOR_EMAIL_APPROVAL_ROOT=/var/lib/upp-operator/email-approvals \
  node scripts/operator/email-send-approval.mjs \
    --input /approved/task/gmail-send-record.json \
    --approve \
    --approved-by Jeremy \
    --expires-seconds 900 \
    --confirm 'APPROVE_EMAIL:<exact-payload-sha256>'
```

Add the returned path to `payload.approval_receipt` without changing any other message field. Any recipient, subject, body, HTML, attachment metadata, attachment content, operation ID, or idempotency-key change invalidates the receipt.

## Execute through the approved wrapper

Configure the action dispatcher so `gmail_send` resolves only to:

```json
["node", "/opt/upp-opencode/scripts/operator/gmail-send-approved-local.mjs"]
```

Required executor environment:

```bash
OPERATOR_EMAIL_APPROVAL_ROOT=/var/lib/upp-operator/email-approvals
OPERATOR_EMAIL_APPROVAL_OWNER_UID=0
OPERATOR_EMAIL_APPROVAL_MAX_SECONDS=900
OPERATOR_GMAIL_ATTACHMENT_ROOTS=/approved/attachment/root
GOOGLE_GMAIL_ACCESS_TOKEN=<executor-only-token>
```

The wrapper verifies the root-controlled receipt before it starts the existing Gmail executor. The existing executor retains deterministic Message-ID deduplication and post-send verification.

## Automations and sequences

Email automations are draft-producing workflows only. Each individual delivery requires its own exact final-message preview, approval receipt, operation ID, and idempotency key. A receipt always contains:

```json
{
  "intent": "send_once",
  "allow_followups": false
}
```

Do not reuse one approval for a sequence, changed message, changed recipient, reply, or scheduled follow-up.

## Failure handling

When approval is absent, expired, writable by the operator account, outside the approved root, owned by the wrong UID, or mismatched to the payload:

```text
Reject only the email delivery
→ preserve the draft and queue record
→ obtain a fresh exact-payload approval
→ do not switch to the direct connector
→ do not reroute through a model gateway or alternate provider
```

If a previous send outcome is uncertain, search Gmail by the deterministic Message-ID and operation ID before any replay.

## Validation

```bash
node --check scripts/operator/email-send-approval.mjs
node --check scripts/operator/gmail-send-approved-local.mjs
node --check scripts/operator/email-send-approval-selftest.mjs
node scripts/operator/email-send-approval-selftest.mjs
```
