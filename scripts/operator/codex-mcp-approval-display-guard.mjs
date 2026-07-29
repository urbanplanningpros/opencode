import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function normalizedLines(value) {
  return String(value || "").replace(/\r\n/g, "\n").split("\n")
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node codex-mcp-approval-display-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

const inputPath = path.resolve(String(args.input))
let evidence
try {
  const stat = fs.lstatSync(inputPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"))
} catch (error) {
  console.error(`Unable to read approval evidence: ${error.message}`)
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
if (prohibited.test(JSON.stringify({ route: evidence.route, provider: evidence.provider, model: evidence.model }))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route" }, null, 2))
  process.exit(64)
}

const required = ["operation_id", "idempotency_key", "target", "risk", "exact_operation", "source_message"]
const missing = required.filter((key) => typeof evidence[key] !== "string" || evidence[key].trim().length === 0)
if (missing.length > 0) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_required_fields", missing }, null, 2))
  process.exit(2)
}

const payload = canonical({
  operation_id: evidence.operation_id,
  idempotency_key: evidence.idempotency_key,
  target: evidence.target,
  risk: evidence.risk,
  exact_operation: evidence.exact_operation,
  source_message: evidence.source_message,
  arguments: evidence.arguments ?? null,
})
const payloadSha256 = sha256(JSON.stringify(payload))
const sourceLines = normalizedLines(evidence.source_message)
const renderedLines = normalizedLines(evidence.rendered_message)
const sourceBreaks = Math.max(0, sourceLines.length - 1)
const renderedBreaks = Math.max(0, renderedLines.length - 1)
const displayIntegrity = sourceBreaks === 0 || renderedBreaks >= sourceBreaks

const receipt = evidence.approval_receipt
const receiptMatches = Boolean(
  receipt &&
    receipt.approved === true &&
    receipt.operation_id === evidence.operation_id &&
    receipt.idempotency_key === evidence.idempotency_key &&
    receipt.target === evidence.target &&
    receipt.exact_operation === evidence.exact_operation &&
    receipt.payload_sha256 === payloadSha256,
)
const independentPreview = evidence.out_of_band_preview_verified === true
const writeIntent = evidence.write_intent !== false

let admitted = true
let reason = "verified"
let exitCode = 0
if (writeIntent && !receiptMatches) {
  admitted = false
  reason = "exact_approval_receipt_required"
  exitCode = 64
} else if (!displayIntegrity && !independentPreview) {
  admitted = false
  reason = "desktop_approval_display_lost_structure"
  exitCode = 75
}

const report = {
  admitted,
  reason,
  operation_id: evidence.operation_id,
  payload_sha256: payloadSha256,
  display_integrity: displayIntegrity,
  source_line_breaks: sourceBreaks,
  rendered_line_breaks: renderedBreaks,
  approval_receipt_matches: receiptMatches,
  out_of_band_preview_verified: independentPreview,
  protocol: admitted
    ? "Execute only once with the bound idempotency key, then independently verify the target state."
    : reason === "desktop_approval_display_lost_structure"
      ? "Withhold Desktop approval authority for this operation. Render the exact source message and structured fields outside Desktop, approve the payload hash, then rerun the guard."
      : "Create a short-lived approval receipt bound to the exact payload hash, operation ID, idempotency key, target, and exact operation.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
