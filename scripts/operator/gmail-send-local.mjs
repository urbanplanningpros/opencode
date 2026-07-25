import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function fail(message, code = 64) {
  console.error(message)
  process.exit(code)
}

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function wrapBase64(value) {
  return Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""
}

function encodeHeader(value) {
  const text = String(value ?? "")
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`
}

function sanitizeHeader(value, name) {
  const text = String(value ?? "").trim()
  if (!text) return ""
  if (/\r|\n/.test(text)) fail(`${name} contains a newline`)
  return text
}

function normalizeRecipients(value, name) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",")
  const recipients = items.map((item) => sanitizeHeader(item, name)).filter(Boolean)
  if (name === "to" && recipients.length === 0) fail("payload.to requires at least one recipient")
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

function allowedRoots() {
  const configured = process.env.OPERATOR_GMAIL_ATTACHMENT_ROOTS
  const roots = configured ? configured.split(path.delimiter) : [process.cwd()]
  return roots.map((root) => fs.realpathSync(path.resolve(root)))
}

function insideRoot(file, root) {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function attachments(payload) {
  const roots = allowedRoots()
  const limit = Number(process.env.OPERATOR_GMAIL_MAX_ATTACHMENT_BYTES || 20 * 1024 * 1024)
  let total = 0
  return (payload.attachments ?? []).map((attachment, index) => {
    const input = typeof attachment === "string" ? { path: attachment } : attachment
    if (!input?.path) fail(`attachment ${index + 1} is missing path`)
    const resolved = fs.realpathSync(path.resolve(input.path))
    if (!roots.some((root) => insideRoot(resolved, root))) fail(`attachment is outside approved roots: ${resolved}`)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) fail(`attachment is not a regular file: ${resolved}`)
    total += stat.size
    if (total > limit) fail(`attachments exceed ${limit} bytes`)
    const filename = sanitizeHeader(input.filename || path.basename(resolved), "attachment filename")
    return {
      path: resolved,
      filename,
      mime_type: sanitizeHeader(input.mime_type || mimeType(resolved), "attachment mime type"),
      content: fs.readFileSync(resolved),
    }
  })
}

function buildMessage(record) {
  if (record.action !== "gmail_send") fail(`unsupported action: ${record.action}`)
  if (!record.idempotency_key) fail("idempotency_key is required")
  const payload = record.payload ?? {}
  const to = normalizeRecipients(payload.to, "to")
  const cc = normalizeRecipients(payload.cc, "cc")
  const bcc = normalizeRecipients(payload.bcc, "bcc")
  const subject = sanitizeHeader(payload.subject, "subject")
  if (!subject) fail("payload.subject is required")
  const text = String(payload.body_text ?? payload.body ?? "")
  const html = payload.body_html == null ? null : String(payload.body_html)
  const files = attachments(payload)
  const digest = crypto.createHash("sha256").update(record.idempotency_key).digest("hex")
  const messageId = `<upp-${digest.slice(0, 32)}@operator.local>`
  const mixed = `upp-mixed-${digest.slice(0, 20)}`
  const alternative = `upp-alt-${digest.slice(20, 40)}`
  const headers = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
    `X-UPP-Operation-ID: ${sanitizeHeader(record.operation_id, "operation_id")}`,
    `X-UPP-Idempotency-Key-SHA256: ${digest}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ]
  const bodyParts =
    html == null
      ? [
          `--${mixed}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          text,
        ]
      : [
          `--${mixed}`,
          `Content-Type: multipart/alternative; boundary="${alternative}"`,
          "",
          `--${alternative}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          text,
          `--${alternative}`,
          'Content-Type: text/html; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          html,
          `--${alternative}--`,
        ]
  for (const file of files) {
    bodyParts.push(
      `--${mixed}`,
      `Content-Type: ${file.mime_type}; name="${file.filename.replace(/"/g, "'")}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${file.filename.replace(/"/g, "'")}"`,
      "",
      wrapBase64(file.content),
    )
  }
  bodyParts.push(`--${mixed}--`, "")
  const raw = [...headers, "", ...bodyParts].join("\r\n")
  return { raw, messageId, attachmentCount: files.length }
}

async function gmail(token, endpoint, options = {}) {
  const response = await fetch(`${process.env.OPERATOR_GMAIL_API_BASE || "https://gmail.googleapis.com/gmail/v1"}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000)
    throw new Error(`Gmail API ${response.status}: ${detail}`)
  }
  return response.json()
}

async function verifyMessage(token, id, expectedMessageId, operationId) {
  const message = await gmail(
    token,
    `/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=X-UPP-Operation-ID`,
  )
  const headers = Object.fromEntries((message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]))
  return headers["message-id"] === expectedMessageId && headers["x-upp-operation-id"] === operationId
}

let input = ""
for await (const chunk of process.stdin) input += chunk
let record
try {
  record = JSON.parse(input)
} catch (error) {
  fail(`invalid queue record: ${error.message}`)
}

const built = buildMessage(record)
if (process.env.OPERATOR_GMAIL_DRY_RUN === "true") {
  process.stdout.write(
    JSON.stringify({
      verified: true,
      dry_run: true,
      operation_id: record.operation_id,
      message_id: built.messageId,
      attachment_count: built.attachmentCount,
      raw_bytes: Buffer.byteLength(built.raw),
    }),
  )
  process.exit(0)
}

const token = process.env.GOOGLE_GMAIL_ACCESS_TOKEN
if (!token) fail("GOOGLE_GMAIL_ACCESS_TOKEN is required", 69)

const query = encodeURIComponent(`rfc822msgid:${built.messageId}`)
const existing = await gmail(token, `/users/me/messages?q=${query}&maxResults=1`)
if (existing.messages?.[0]?.id) {
  const verified = await verifyMessage(token, existing.messages[0].id, built.messageId, record.operation_id)
  process.stdout.write(
    JSON.stringify({
      verified,
      existing: true,
      operation_id: record.operation_id,
      message_id: existing.messages[0].id,
    }),
  )
  process.exit(verified ? 0 : 70)
}

const sent = await gmail(token, "/users/me/messages/send", {
  method: "POST",
  body: JSON.stringify({ raw: base64url(built.raw) }),
})
const verified = await verifyMessage(token, sent.id, built.messageId, record.operation_id)
process.stdout.write(
  JSON.stringify({
    verified,
    existing: false,
    operation_id: record.operation_id,
    message_id: sent.id,
    thread_id: sent.threadId,
  }),
)
process.exit(verified ? 0 : 70)
