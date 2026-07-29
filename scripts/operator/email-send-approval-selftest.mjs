import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { buildEmailApprovalEnvelope, verifyEmailApproval } from "./email-send-approval.mjs"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function expectFailure(fn, pattern) {
  try {
    fn()
  } catch (error) {
    assert(pattern.test(error.message), `unexpected error: ${error.message}`)
    return
  }
  throw new Error(`expected failure matching ${pattern}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "upp-email-approval-"))
const attachment = path.join(root, "report.txt")
fs.writeFileSync(attachment, "approved attachment\n")
const record = {
  action: "gmail_send",
  operation_id: "email-op-1",
  idempotency_key: "email-idempotency-1",
  payload: {
    to: ["recipient@example.com"],
    subject: "Approved report",
    body_text: "Attached is the approved report.",
    attachments: [{ path: attachment }],
  },
}
const { payload_sha256 } = buildEmailApprovalEnvelope(record)
const now = new Date("2026-07-29T04:00:00.000Z")
const receiptPath = path.join(root, "approval.json")
const receipt = {
  version: 1,
  action: "gmail_send",
  intent: "send_once",
  allow_followups: false,
  operation_id: record.operation_id,
  idempotency_key: record.idempotency_key,
  payload_sha256,
  approved_by: "operator-test",
  approved_at: "2026-07-29T03:59:00.000Z",
  expires_at: "2026-07-29T04:09:00.000Z",
}
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })
record.payload.approval_receipt = receiptPath
const uid = typeof process.getuid === "function" ? process.getuid() : 0
const verified = verifyEmailApproval(record, { approvalRoot: root, ownerUid: uid, now })
assert(verified.verified === true, "valid approval was not accepted")
assert(verified.payload_sha256 === payload_sha256, "approval hash changed")

const changed = structuredClone(record)
changed.payload.subject = "Changed after approval"
expectFailure(() => verifyEmailApproval(changed, { approvalRoot: root, ownerUid: uid, now }), /changed after approval/)

const sequenced = structuredClone(record)
sequenced.payload.followups = [{ delay: "2 days" }]
expectFailure(() => buildEmailApprovalEnvelope(sequenced), /sequences, scheduling, and follow-ups/)

fs.chmodSync(receiptPath, 0o664)
expectFailure(() => verifyEmailApproval(record, { approvalRoot: root, ownerUid: uid, now }), /group- or world-writable/)
fs.chmodSync(receiptPath, 0o644)

const expired = { ...receipt, expires_at: "2026-07-29T03:59:30.000Z" }
fs.writeFileSync(receiptPath, `${JSON.stringify(expired, null, 2)}\n`, { mode: 0o644 })
expectFailure(() => verifyEmailApproval(record, { approvalRoot: root, ownerUid: uid, now }), /expired/)
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })

const wrapper = path.join(import.meta.dirname, "gmail-send-approved-local.mjs")
const allowed = spawnSync(process.execPath, [wrapper], {
  input: JSON.stringify(record),
  encoding: "utf8",
  env: {
    ...process.env,
    OPERATOR_EMAIL_APPROVAL_ROOT: root,
    OPERATOR_EMAIL_APPROVAL_OWNER_UID: String(uid),
    OPERATOR_EMAIL_APPROVAL_TEST_NO_SEND: "true",
  },
})
assert(allowed.status === 0, `approved wrapper failed: ${allowed.stderr}`)
const allowedOutput = JSON.parse(allowed.stdout)
assert(allowedOutput.verified === true && allowedOutput.test_no_send === true, "wrapper did not verify approval")

const unapproved = structuredClone(record)
delete unapproved.payload.approval_receipt
const denied = spawnSync(process.execPath, [wrapper], {
  input: JSON.stringify(unapproved),
  encoding: "utf8",
  env: {
    ...process.env,
    OPERATOR_EMAIL_APPROVAL_ROOT: root,
    OPERATOR_EMAIL_APPROVAL_OWNER_UID: String(uid),
    OPERATOR_EMAIL_APPROVAL_TEST_NO_SEND: "true",
  },
})
assert(denied.status === 64, `unapproved wrapper exit was ${denied.status}`)
assert(/approval_receipt/.test(denied.stderr), "unapproved wrapper did not explain the approval requirement")

fs.rmSync(root, { recursive: true, force: true })
console.log("email send approval self-test passed")
