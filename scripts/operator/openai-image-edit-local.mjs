import fs from "node:fs"
import path from "node:path"
import { nowIso, sha256, writeJsonAtomic } from "./lib.mjs"

const DIRECT_API_BASE = "https://api.openai.com/v1"
const DEFAULT_MODEL = "gpt-5.6"
const DEFAULT_MAX_REFERENCES = 8
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 180_000
const FORBIDDEN_ROUTE_PATTERNS = [/anthropic/i, /claude/i, /manus/i, /openrouter/i, /bedrock/i, /vertex/i, /copilot/i, /gateway/i]

function fail(message, code = 64) {
  console.error(message)
  process.exit(code)
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`)
  return value
}

function normalizeBase(value) {
  return String(value || DIRECT_API_BASE).replace(/\/+$/, "")
}

function allowedApiBase() {
  const base = normalizeBase(process.env.OPERATOR_OPENAI_API_BASE)
  if (base === DIRECT_API_BASE) return base
  const testMode = process.env.OPERATOR_OPENAI_IMAGE_EDIT_TEST_MODE === "true"
  if (testMode && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v1$/i.test(base)) return base
  fail(`Only the direct OpenAI API endpoint is allowed; rejected ${base}`)
}

function allowedModels() {
  const raw = process.env.OPERATOR_OPENAI_IMAGE_EDIT_ALLOWED_MODELS || DEFAULT_MODEL
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) fail("OPERATOR_OPENAI_IMAGE_EDIT_ALLOWED_MODELS cannot be empty")
  for (const value of values) {
    if (FORBIDDEN_ROUTE_PATTERNS.some((pattern) => pattern.test(value))) fail(`Prohibited model or route in allowlist: ${value}`)
  }
  return new Set(values)
}

function resolveRoots(name) {
  const raw = process.env[name]
  const values = raw ? raw.split(path.delimiter) : [process.cwd()]
  return values.map((value) => fs.realpathSync(path.resolve(value)))
}

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function assertInside(candidate, roots, label) {
  if (!roots.some((root) => insideRoot(candidate, root))) fail(`${label} is outside approved roots: ${candidate}`)
}

function mimeType(file) {
  const extension = path.extname(file).toLowerCase()
  const type = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  }[extension]
  if (!type) fail(`Unsupported input image type: ${extension || "none"}`)
  return type
}

function imageInputs(payload) {
  if (!Array.isArray(payload.images) || payload.images.length === 0) fail("payload.images requires at least one image")
  const maxReferences = envNumber("OPERATOR_OPENAI_IMAGE_EDIT_MAX_REFERENCES", DEFAULT_MAX_REFERENCES)
  if (payload.images.length > maxReferences) fail(`payload.images exceeds the ${maxReferences}-reference limit`)

  const roots = resolveRoots("OPERATOR_IMAGE_INPUT_ROOTS")
  const maxImageBytes = envNumber("OPERATOR_OPENAI_IMAGE_EDIT_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES)
  const maxTotalBytes = envNumber("OPERATOR_OPENAI_IMAGE_EDIT_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES)
  let totalBytes = 0

  return payload.images.map((entry, index) => {
    const input = typeof entry === "string" ? { path: entry } : entry
    if (!input?.path) fail(`image ${index + 1} is missing path`)
    const resolved = fs.realpathSync(path.resolve(input.path))
    assertInside(resolved, roots, `image ${index + 1}`)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) fail(`image ${index + 1} is not a regular file`)
    if (stat.size > maxImageBytes) fail(`image ${index + 1} exceeds ${maxImageBytes} bytes`)
    totalBytes += stat.size
    if (totalBytes > maxTotalBytes) fail(`input images exceed ${maxTotalBytes} bytes combined`)
    const content = fs.readFileSync(resolved)
    const type = mimeType(resolved)
    return {
      bytes: stat.size,
      sha256: sha256(content),
      input: {
        type: "input_image",
        image_url: `data:${type};base64,${content.toString("base64")}`,
      },
    }
  })
}

function outputTarget(payload) {
  if (!payload.output_path) fail("payload.output_path is required")
  const output = path.resolve(payload.output_path)
  if (path.extname(output).toLowerCase() !== ".png") fail("payload.output_path must end in .png")
  const parent = fs.realpathSync(path.dirname(output))
  const roots = resolveRoots("OPERATOR_IMAGE_OUTPUT_ROOTS")
  assertInside(parent, roots, "output directory")
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output)
    if (stat.isSymbolicLink()) fail("output target cannot be a symbolic link")
    if (!stat.isFile()) fail("output target must be a regular file")
    assertInside(fs.realpathSync(output), roots, "output target")
  }
  return output
}

function atomicWrite(file, data) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 })
  fs.renameSync(temp, file)
}

function receiptPath(record) {
  const root = path.resolve(process.env.OPERATOR_STATE_DIR || path.join(process.cwd(), ".operator-state"))
  const digest = sha256(record.idempotency_key)
  return path.join(root, "openai-image-edit", "receipts", `${digest}.json`)
}

function readReceipt(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function responseRequestId(response) {
  return response.headers.get("x-request-id") || response.headers.get("request-id") || null
}

let input = ""
for await (const chunk of process.stdin) input += chunk
let record
try {
  record = JSON.parse(input)
} catch (error) {
  fail(`invalid queue record: ${error.message}`)
}

if (record.action !== "openai_image_edit") fail(`unsupported action: ${record.action}`)
if (!record.operation_id) fail("operation_id is required")
if (!record.idempotency_key) fail("idempotency_key is required")

const payload = record.payload ?? {}
const prompt = String(payload.prompt ?? "").trim()
if (!prompt) fail("payload.prompt is required")
if (Buffer.byteLength(prompt, "utf8") > 20_000) fail("payload.prompt exceeds 20000 bytes")
const model = String(payload.model || process.env.OPERATOR_OPENAI_IMAGE_EDIT_MODEL || DEFAULT_MODEL).trim()
if (FORBIDDEN_ROUTE_PATTERNS.some((pattern) => pattern.test(model))) fail(`Prohibited model or route: ${model}`)
if (!allowedModels().has(model)) fail(`Model is not approved for direct image editing: ${model}`)
const apiBase = allowedApiBase()
const images = imageInputs(payload)
const output = outputTarget(payload)
const payloadDigest = sha256(
  JSON.stringify({
    operation_id: record.operation_id,
    model,
    prompt_sha256: sha256(prompt),
    image_sha256: images.map((image) => image.sha256),
    output,
  }),
)
const requestBody = {
  model,
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: prompt }, ...images.map((image) => image.input)],
    },
  ],
  tools: [{ type: "image_generation" }],
}

if (process.env.OPERATOR_OPENAI_IMAGE_EDIT_DRY_RUN === "true") {
  process.stdout.write(
    JSON.stringify({
      verified: true,
      dry_run: true,
      operation_id: record.operation_id,
      model,
      endpoint: `${apiBase}/responses`,
      reference_count: images.length,
      input_bytes: images.reduce((sum, image) => sum + image.bytes, 0),
      payload_sha256: payloadDigest,
      output_path: output,
    }),
  )
  process.exit(0)
}

const receiptFile = receiptPath(record)
const prior = readReceipt(receiptFile)
if (prior?.status === "completed") {
  if (!fs.existsSync(output)) fail("completed receipt exists but output file is missing", 70)
  const outputSha = sha256(fs.readFileSync(output))
  const verified = outputSha === prior.output_sha256 && prior.payload_sha256 === payloadDigest
  process.stdout.write(
    JSON.stringify({
      verified,
      existing: true,
      operation_id: record.operation_id,
      response_id: prior.response_id,
      request_id: prior.request_id,
      output_path: output,
      output_sha256: outputSha,
    }),
  )
  process.exit(verified ? 0 : 70)
}
if (prior && ["dispatching", "uncertain"].includes(prior.status)) {
  fail(`Prior image-edit dispatch requires reconciliation: ${receiptFile}`, 75)
}
if (fs.existsSync(output)) {
  fail("output target already exists without a matching completed receipt", 70)
}

const token = process.env.OPENAI_API_KEY
if (!token) fail("OPENAI_API_KEY is required", 69)
writeJsonAtomic(receiptFile, {
  status: "dispatching",
  operation_id: record.operation_id,
  payload_sha256: payloadDigest,
  model,
  reference_count: images.length,
  created_at: nowIso(),
  updated_at: nowIso(),
})

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), envNumber("OPERATOR_OPENAI_IMAGE_EDIT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS))
let response
try {
  response = await fetch(`${apiBase}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  })
} catch (error) {
  clearTimeout(timeout)
  writeJsonAtomic(receiptFile, {
    status: "uncertain",
    operation_id: record.operation_id,
    payload_sha256: payloadDigest,
    model,
    reference_count: images.length,
    error: error.name === "AbortError" ? "request timed out after dispatch" : "transport failed after dispatch",
    updated_at: nowIso(),
  })
  fail(`Direct OpenAI image edit outcome is uncertain: ${error.message}`, 75)
}
clearTimeout(timeout)

const requestId = responseRequestId(response)
let responseJson
try {
  responseJson = await response.json()
} catch {
  responseJson = null
}
if (!response.ok) {
  const uncertain = response.status >= 500 || [408, 409, 429].includes(response.status)
  writeJsonAtomic(receiptFile, {
    status: uncertain ? "uncertain" : "rejected",
    operation_id: record.operation_id,
    payload_sha256: payloadDigest,
    model,
    reference_count: images.length,
    http_status: response.status,
    request_id: requestId,
    error_code: responseJson?.error?.code || null,
    updated_at: nowIso(),
  })
  fail(`Direct OpenAI image edit failed with HTTP ${response.status}; request_id=${requestId || "unavailable"}`, uncertain ? 75 : 70)
}

const call = Array.isArray(responseJson?.output)
  ? responseJson.output.find((item) => item?.type === "image_generation_call" && typeof item.result === "string")
  : null
if (!call) {
  writeJsonAtomic(receiptFile, {
    status: "rejected",
    operation_id: record.operation_id,
    payload_sha256: payloadDigest,
    model,
    reference_count: images.length,
    response_id: responseJson?.id || null,
    request_id: requestId,
    error: "response contained no image_generation_call result",
    updated_at: nowIso(),
  })
  fail(`Direct OpenAI response contained no generated image; request_id=${requestId || "unavailable"}`, 70)
}

const outputBytes = Buffer.from(call.result, "base64")
const maxOutputBytes = envNumber("OPERATOR_OPENAI_IMAGE_EDIT_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES)
if (outputBytes.length === 0 || outputBytes.length > maxOutputBytes) fail(`Generated image size is invalid: ${outputBytes.length} bytes`, 70)
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (!outputBytes.subarray(0, pngSignature.length).equals(pngSignature)) fail("Generated image is not a PNG", 70)
atomicWrite(output, outputBytes)
const outputSha = sha256(outputBytes)
writeJsonAtomic(receiptFile, {
  status: "completed",
  operation_id: record.operation_id,
  payload_sha256: payloadDigest,
  model,
  reference_count: images.length,
  response_id: responseJson.id || null,
  request_id: requestId,
  output_path: output,
  output_sha256: outputSha,
  output_bytes: outputBytes.length,
  completed_at: nowIso(),
  updated_at: nowIso(),
})
process.stdout.write(
  JSON.stringify({
    verified: true,
    existing: false,
    operation_id: record.operation_id,
    response_id: responseJson.id || null,
    request_id: requestId,
    output_path: output,
    output_sha256: outputSha,
    output_bytes: outputBytes.length,
  }),
)
