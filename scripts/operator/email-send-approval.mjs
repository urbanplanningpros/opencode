import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ALLOWED_PAYLOAD_FIELDS = new Set([
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "body_text",
  "body_html",
  "attachments",
  "approval_receipt",
])
const ALLOWED_ATTACHMENT_FIELDS = new Set(["path", "filename", "mime_type"])

function operatorError(message, code = 64) {
  const error = new Error(message)
  error.exitCode = code
  return error
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function normalizeRecipients(value, name) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",")
  const recipients = items.map((item) => String(item).trim()).filter(Boolean)
  if (name === "to" && recipients.length === 0) throw operatorError("payload.to requires at least one recipient")
  for (const recipient of recipients) {
    if (/\r|\n/.test(recipient)) throw operatorError(`${name} contains a newline`)
  }
  return recipients
}

function mimeType(file) {
  const extension = path.extname(file).toLowerCase()
  return {
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".html": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".zip": "application/zip",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }[extension] ?? "application/octet-stream"
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function normalizedAttachments(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw operatorError("payload.attachments must be an array")
  return value.map((attachment, index) => {
    const input = typeof attachment === "string" ? { path: attachment } : attachment
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw operatorError(`attachment ${index + 1} must be a path or object`)
    }
    for (const key of Object.keys(input)) {
      if (!ALLOWED_ATTACHMENT_FIELDS.has(key)) throw operatorError(`unsupported attachment field: ${key}`)
    }
    if (!input.path) throw operatorError(`attachment ${index + 1} is missing path`)
    const requested = path.resolve(String(input.path))
    const metadata = fs.lstatSync(requested)
    if (metadata.isSymbolicLink()) throw operatorError(`attachment may not be a symbolic link: ${requested}`)
    const resolved = fs.realpathSync(requested)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw operatorError(`attachment is not a regular file: ${resolved}`)
    const filename = String(input.filename || path.basename(resolved)).trim()
    const type = String(input.mime_type || mimeType(resolved)).trim()
    if (!filename || /\r|\n/.test(filename)) throw operatorError(`attachment ${index + 1} has an invalid filename`)
    if (!type || /\r|\n/.test(type)) throw operatorError(`attachment ${index + 1} has an invalid MIME type`)
    return {
      path: resolved,
      filename,
      mime_type: type,
      size: stat.size,
      sha256: fileSha256(resolved),
    }
  })
}

export function buildEmailApprovalEnvelope(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw operatorError("queue record must be an object")
  if (record.action !== "gmail_send") throw operatorError(`unsupported action: ${record.action}`)
  if (!record.operation_id) throw operatorError("operation_id is required")
  if (!record.idempotency_key) throw operatorError("idempotency_key is required")
  const payload = record.payload ?? {}
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw operatorError("payload must be an object")
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_FIELDS.has(key)) {
      throw operatorError(`unsupported Gmail payload field '${key}'; sequences, scheduling, and follow-ups require separate approval`)
    }
  }
  if (payload.body_text != null && payload.body != null && String(payload.body_text) !== String(payload.body)) {
    throw operatorError("payload.body and payload.body_text disagree")
  }
  const subject = String(payload.subject ?? "").trim()
  if (!subject) throw operatorError("payload.subject is required")
  if (/\r|\n/.test(subject)) throw operatorError("subject contains a newline")
  const envelope = {
    version: 1,
    action: "gmail_send",
    operation_id: String(record.operation_id),
    idempotency_key: String(record.idempotency_key),
    intent: "send_once",
    to: normalizeRecipients(payload.to, "to"),
    cc: normalizeRecipients(payload.cc, "cc"),
    bcc: normalizeRecipients(payload.bcc, "bcc"),
    subject,
    body_text: String(payload.body_text ?? payload.body ?? ""),
    body_html: payload.body_html == null ? null : String(payload.body_html),
    attachments: normalizedAttachments(payload.attachments),
  }
  return {
    envelope,
    payload_sha256: sha256(canonicalJson(envelope)),
  }
}

function insideRoot(file, root) {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function parseTimestamp(value, name) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw operatorError(`${name} is invalid`)
  return date
}

export function verifyEmailApproval(record, options = {}) {
  const { envelope, payload_sha256 } = buildEmailApprovalEnvelope(record)
  const receiptInput = record.approval_receipt || record.payload?.approval_receipt
  if (!receiptInput) throw operatorError("a root-controlled approval_receipt is required before Gmail delivery")
  const configuredRoot = options.approvalRoot || process.env.OPERATOR_EMAIL_APPROVAL_ROOT
  if (!configuredRoot) throw operatorError("OPERATOR_EMAIL_APPROVAL_ROOT is required")
  const root = fs.realpathSync(path.resolve(configuredRoot))
  const requested = path.resolve(String(receiptInput))
  const linkStat = fs.lstatSync(requested)
  if (linkStat.isSymbolicLink()) throw operatorError("approval receipt may not be a symbolic link")
  const receiptPath = fs.realpathSync(requested)
  if (!insideRoot(receiptPath, root)) throw operatorError("approval receipt is outside OPERATOR_EMAIL_APPROVAL_ROOT")
  const stat = fs.statSync(receiptPath)
  if (!stat.isFile()) throw operatorError("approval receipt is not a regular file")
  const expectedOwner = Number(options.ownerUid ?? process.env.OPERATOR_EMAIL_APPROVAL_OWNER_UID ?? 0)
  if (Number.isFinite(expectedOwner) && stat.uid !== expectedOwner) {
    throw operatorError(`approval receipt owner UID ${stat.uid} does not match required UID ${expectedOwner}`)
  }
  if ((stat.mode & 0o022) !== 0) throw operatorError("approval receipt must not be group- or world-writable")
  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
  } catch (error) {
    throw operatorError(`approval receipt is invalid JSON: ${error.message}`)
  }
  if (receipt.version !== 1 || receipt.action !== "gmail_send" || receipt.intent !== "send_once") {
    throw operatorError("approval receipt does not authorize one Gmail send")
  }
  if (receipt.allow_followups !== false) throw operatorError("approval receipt must explicitly prohibit follow-ups")
  if (receipt.operation_id !== envelope.operation_id || receipt.idempotency_key !== envelope.idempotency_key) {
    throw operatorError("approval receipt operation or idempotency key does not match")
  }
  if (receipt.payload_sha256 !== payload_sha256) throw operatorError("email payload changed after approval")
  if (!String(receipt.approved_by ?? "").trim()) throw operatorError("approval receipt is missing approved_by")
  const approvedAt = parseTimestamp(receipt.approved_at, "approved_at")
  const expiresAt = parseTimestamp(receipt.expires_at, "expires_at")
  const now = options.now ? new Date(options.now) : new Date()
  if (expiresAt <= now) throw operatorError("email approval receipt has expired")
  if (approvedAt > now) throw operatorError("email approval receipt is dated in the future")
  const maxLifetimeSeconds = Number(options.maxLifetimeSeconds ?? process.env.OPERATOR_EMAIL_APPROVAL_MAX_SECONDS ?? 900)
  if ((expiresAt.getTime() - approvedAt.getTime()) / 1000 > maxLifetimeSeconds) {
    throw operatorError(`email approval lifetime exceeds ${maxLifetimeSeconds} seconds`)
  }
  return {
    verified: true,
    receipt_path: receiptPath,
    payload_sha256,
    approved_by: receipt.approved_by,
    expires_at: expiresAt.toISOString(),
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

async function readRecord(inputPath) {
  if (inputPath) return JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"))
  let input = ""
  for await (const chunk of process.stdin) input += chunk
  return JSON.parse(input)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const record = await readRecord(args.input)
  const { envelope, payload_sha256 } = buildEmailApprovalEnvelope(record)
  const confirmation = `APPROVE_EMAIL:${payload_sha256}`
  if (!args.approve) {
    process.stdout.write(`${JSON.stringify({ envelope, payload_sha256, confirmation_required: confirmation }, null, 2)}\n`)
    return
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  const allowNonRoot = /^(1|true|yes)$/i.test(process.env.OPERATOR_EMAIL_APPROVAL_ALLOW_NONROOT || "")
  if (uid !== 0 && !allowNonRoot) throw operatorError("approval receipts must be created by root or an isolated approval service")
  if (args.confirm !== confirmation) throw operatorError(`confirmation must equal ${confirmation}`)
  const approvedBy = String(args["approved-by"] ?? "").trim()
  if (!approvedBy) throw operatorError("--approved-by is required")
  const rootInput = args["approval-root"] || process.env.OPERATOR_EMAIL_APPROVAL_ROOT
  if (!rootInput) throw operatorError("--approval-root or OPERATOR_EMAIL_APPROVAL_ROOT is required")
  const root = path.resolve(rootInput)
  fs.mkdirSync(root, { recursive: true, mode: 0o755 })
  const lifetime = Math.min(Math.max(Number(args["expires-seconds"] || 900), 60), 900)
  const approvedAt = new Date()
  const receipt = {
    version: 1,
    action: "gmail_send",
    intent: "send_once",
    allow_followups: false,
    operation_id: envelope.operation_id,
    idempotency_key: envelope.idempotency_key,
    payload_sha256,
    approved_by: approvedBy,
    approved_at: approvedAt.toISOString(),
    expires_at: new Date(approvedAt.getTime() + lifetime * 1000).toISOString(),
  }
  const safeOperation = envelope.operation_id.replace(/[^a-zA-Z0-9._-]/g, "-")
  const output = path.join(root, `${safeOperation}-${payload_sha256.slice(0, 16)}.json`)
  const temp = `${output}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644, flag: "wx" })
  fs.renameSync(temp, output)
  process.stdout.write(`${JSON.stringify({ approved: true, approval_receipt: output, payload_sha256 }, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(error.exitCode || 2)
  })
}
