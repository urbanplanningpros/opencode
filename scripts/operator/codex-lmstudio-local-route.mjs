import process from "node:process"

const MAX_PROMPT_BYTES = 1024 * 1024
const MAX_JSON_BYTES = 16 * 1024 * 1024
const DEFAULT_MODEL = "openai/gpt-oss-20b"
const PROHIBITED = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway)/i

function fail(message, code = 64) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const flags = new Set(argv)
  const modes = ["--probe", "--execute", "--canary"].filter((mode) => flags.has(mode))
  if (modes.length > 1) fail("Choose exactly one of --probe, --execute, or --canary.", 2)
  return {
    mode: modes[0] || "--probe",
    json: flags.has("--json"),
  }
}

function parseAllowedModels(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail("OPERATOR_LMSTUDIO_ALLOWED_MODELS must be a JSON string array.")
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item.trim())) {
    fail("OPERATOR_LMSTUDIO_ALLOWED_MODELS must contain at least one non-empty model ID.")
  }
  if (parsed.some((item) => PROHIBITED.test(item))) fail("The local model allowlist contains a prohibited route.")
  return new Set(parsed)
}

function localBaseUrl() {
  let url
  try {
    url = new URL(process.env.OPERATOR_LMSTUDIO_BASE_URL || "http://127.0.0.1:1234")
  } catch {
    fail("OPERATOR_LMSTUDIO_BASE_URL must be a valid loopback URL.")
  }
  if (url.protocol !== "http:") fail("LM Studio continuity is restricted to loopback HTTP.")
  if (!new Set(["127.0.0.1", "[::1]", "::1"]).has(url.hostname)) {
    fail("LM Studio continuity refuses non-loopback hosts.")
  }
  if (url.username || url.password || url.search || url.hash) fail("LM Studio URL credentials, queries, and fragments are not allowed.")
  if (url.pathname !== "/") fail("OPERATOR_LMSTUDIO_BASE_URL must be the server root, without /v1.")
  return url
}

function authHeaders() {
  const headers = { accept: "application/json" }
  const token = process.env.OPERATOR_LMSTUDIO_API_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function fetchBoundedJson(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" })
  } catch (error) {
    const detail = error?.name === "AbortError" ? "request timed out" : error?.message || String(error)
    throw new Error(`LM Studio request failed: ${detail}`)
  } finally {
    clearTimeout(timer)
  }

  const declared = Number(response.headers.get("content-length") || 0)
  if (declared > MAX_JSON_BYTES) throw new Error("LM Studio response exceeds the configured size limit.")
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("LM Studio response exceeds the configured size limit.")
  const text = new TextDecoder().decode(bytes)
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`LM Studio returned invalid JSON with HTTP ${response.status}.`)
  }
  if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}.`)
  return body
}

async function readPrompt() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_PROMPT_BYTES) fail("Local continuity prompt exceeds 1 MiB.", 64)
    chunks.push(bytes)
  }
  const prompt = Buffer.concat(chunks).toString("utf8").trim()
  if (!prompt) fail("Local continuity execution requires a prompt on stdin.", 2)
  return prompt
}

function modelIds(catalog) {
  if (Array.isArray(catalog?.data)) return catalog.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
  if (Array.isArray(catalog?.models)) {
    return catalog.models.map((entry) => entry?.slug || entry?.id || entry?.key).filter((id) => typeof id === "string")
  }
  return []
}

async function probe(base, model) {
  const catalogUrl = new URL("/v1/models", base)
  const catalog = await fetchBoundedJson(catalogUrl, { method: "GET", headers: authHeaders() }, 5000)
  const ids = modelIds(catalog)
  if (!ids.includes(model)) throw new Error(`Approved model '${model}' is not present in LM Studio.`)
  const codexCatalogCompatible = Array.isArray(catalog?.models)
  return {
    status: codexCatalogCompatible ? "codex_catalog_compatible" : "direct_local_required",
    base_url: base.origin,
    model,
    catalog_shape: codexCatalogCompatible ? "codex_models" : Array.isArray(catalog?.data) ? "openai_data" : "unknown",
    codex_oss_safe: codexCatalogCompatible,
    direct_responses_canary_required: true,
  }
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text
  const parts = []
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") parts.push(content.text)
      else if (typeof content?.output_text === "string") parts.push(content.output_text)
    }
  }
  return parts.join("")
}

async function execute(base, model, prompt) {
  const responseUrl = new URL("/v1/responses", base)
  const body = {
    model,
    input: prompt,
    stream: false,
    store: false,
    tools: [],
  }
  const response = await fetchBoundedJson(
    responseUrl,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    Number(process.env.OPERATOR_LMSTUDIO_TIMEOUT_MS || 120000),
  )
  const text = extractOutputText(response)
  if (!text) throw new Error("LM Studio completed without a text response.")
  return text
}

const args = parseArgs(process.argv.slice(2))
const base = localBaseUrl()
const model = process.env.OPERATOR_LMSTUDIO_MODEL || DEFAULT_MODEL
const allowed = parseAllowedModels(process.env.OPERATOR_LMSTUDIO_ALLOWED_MODELS || JSON.stringify([DEFAULT_MODEL]))
if (PROHIBITED.test(model)) fail("The selected local model contains a prohibited route.")
if (!allowed.has(model)) fail(`Local model '${model}' is not in OPERATOR_LMSTUDIO_ALLOWED_MODELS.`)

try {
  const result = await probe(base, model)
  if (args.mode === "--probe") {
    console.log(JSON.stringify(result, null, args.json ? 2 : 0))
    process.exit(result.codex_oss_safe ? 0 : 75)
  }

  const prompt = args.mode === "--canary" ? "Reply with exactly LOCAL_ROUTE_OK" : await readPrompt()
  const text = await execute(base, model, prompt)
  if (args.mode === "--canary" && text.trim() !== "LOCAL_ROUTE_OK") {
    throw new Error("LM Studio canary returned unexpected text.")
  }
  if (args.json) {
    console.log(JSON.stringify({ ...result, status: "verified", response_text: text }, null, 2))
  } else {
    process.stdout.write(`${text}\n`)
  }
} catch (error) {
  console.error(error?.message || String(error))
  process.exit(69)
}
