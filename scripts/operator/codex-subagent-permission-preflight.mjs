import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

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

function fail(message, details = {}) {
  console.error(JSON.stringify({ status: "blocked", message, ...details }, null, 2))
  process.exit(2)
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(stable(value))
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function normalizedForCompare(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isWithin(child, parent) {
  const relative = path.relative(normalizedForCompare(parent), normalizedForCompare(child))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function assertNoSymbolicSegment(inputPath) {
  const absolute = path.resolve(inputPath)
  const parsed = path.parse(absolute)
  const remainder = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const segment of remainder) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) fail("Writable roots may not contain symbolic-link or reparse-point segments", { path: current })
  }
}

function rootIdentity(inputPath) {
  const requested = path.resolve(inputPath)
  if (!fs.existsSync(requested)) fail("Writable root does not exist", { path: requested })
  assertNoSymbolicSegment(requested)
  const real = fs.realpathSync.native(requested)
  const stat = fs.statSync(real, { bigint: true })
  if (!stat.isDirectory()) fail("Writable root must be a directory", { path: requested })
  return {
    requested,
    real,
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    ctime_ns: String(stat.ctimeNs),
    birthtime_ns: String(stat.birthtimeNs),
  }
}

function asUniqueStrings(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array`)
  const values = value.map((item) => String(item).trim())
  if (values.some((item) => !item)) fail(`${field} contains an empty value`)
  if (values.some((item) => item === "*" || item.includes("**"))) fail(`${field} may not contain wildcard authority`)
  return [...new Set(values)].sort()
}

function validateRoute(route = {}) {
  const provider = String(route.provider || "").toLowerCase()
  const model = String(route.model || "")
  const approvedProviders = new Set(
    String(process.env.OPERATOR_APPROVED_PROVIDERS || "openai,local")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
  if (!approvedProviders.has(provider)) fail("Provider is not approved for delegated execution", { provider })
  if (provider === "local" && route.authorized_local !== true) fail("Local execution route lacks explicit authorization")
  if (!model) fail("An explicit model or local runtime identifier is required")
  if (route.automatic_model_selection !== false) fail("Automatic model selection must be explicitly disabled")
  if (route.gateway) fail("Model gateways are prohibited for delegated execution", { gateway: route.gateway })
  if (Array.isArray(route.fallbacks) && route.fallbacks.length > 0) fail("Automatic fallback chains are prohibited")

  const prohibited = ["anthropic", "claude", "manus", "bedrock", "vertex", "copilot"]
  const routeText = canonicalJson(route).toLowerCase()
  const hit = prohibited.find((needle) => routeText.includes(needle))
  if (hit) fail("Delegated route contains a prohibited provider or selector", { prohibited_match: hit })

  return { provider, model, authorized_local: route.authorized_local === true }
}

function validateManifest(manifest) {
  const required = ["operation_id", "parent_thread_id", "task_name", "environment_id"]
  for (const field of required) {
    if (!String(manifest[field] || "").trim()) fail(`Missing required binding: ${field}`)
  }

  const route = validateRoute(manifest.route)
  const parentRoots = asUniqueStrings(manifest.parent?.write_roots, "parent.write_roots").map(rootIdentity)
  const childRoots = asUniqueStrings(manifest.child?.write_roots, "child.write_roots").map(rootIdentity)
  const parentTools = asUniqueStrings(manifest.parent?.tools, "parent.tools")
  const childTools = asUniqueStrings(manifest.child?.tools, "child.tools")

  for (const childRoot of childRoots) {
    if (!parentRoots.some((parentRoot) => isWithin(childRoot.real, parentRoot.real))) {
      fail("Child writable root exceeds the parent filesystem ceiling", { child_root: childRoot.real })
    }
  }

  if (manifest.child?.network === true && manifest.parent?.network !== true) {
    fail("Child network authority exceeds the parent network ceiling")
  }

  const parentToolSet = new Set(parentTools)
  const extraTools = childTools.filter((tool) => !parentToolSet.has(tool))
  if (extraTools.length > 0) fail("Child tool authority exceeds the parent tool ceiling", { extra_tools: extraTools })

  return {
    route,
    parent: {
      write_roots: parentRoots,
      network: manifest.parent?.network === true,
      tools: parentTools,
    },
    child: {
      write_roots: childRoots,
      network: manifest.child?.network === true,
      tools: childTools,
    },
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    fail(`Unable to read ${label}`, { file, error: error.message })
  }
}

const args = parseArgs(process.argv.slice(2))
const mode = args.prepare ? "prepare" : args.consume ? "consume" : null
if (!mode) fail("Choose exactly one mode: --prepare or --consume")
if (!args.manifest) fail("--manifest is required")
if (!args.receipt) fail("--receipt is required")

const manifestFile = path.resolve(args.manifest)
const receiptFile = path.resolve(args.receipt)
const stateFile = path.resolve(args.state || path.join(path.dirname(receiptFile), "permission-grants-state.json"))
const manifest = readJson(manifestFile, "manifest")
const effective = validateManifest(manifest)
const manifestHash = sha256(canonicalJson(manifest))

if (mode === "prepare") {
  const ttlSeconds = Number(args["ttl-seconds"] || 300)
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) fail("Grant TTL must be between 30 and 900 seconds")
  const preparedAt = new Date()
  const receipt = {
    version: 1,
    status: "prepared",
    grant_id: crypto.randomUUID(),
    prepared_at: preparedAt.toISOString(),
    expires_at: new Date(preparedAt.getTime() + ttlSeconds * 1000).toISOString(),
    manifest_sha256: manifestHash,
    bindings: {
      operation_id: manifest.operation_id,
      parent_thread_id: manifest.parent_thread_id,
      task_name: manifest.task_name,
      environment_id: manifest.environment_id,
    },
    effective,
    warning:
      "Temporary pre-spawn shim only. It detects policy expansion, replay, and filesystem identity drift but cannot atomically bind path identity to the upstream Codex sandbox.",
  }
  atomicWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ status: "prepared", receipt_file: receiptFile, ...receipt }, null, 2))
  process.exit(0)
}

const receipt = readJson(receiptFile, "receipt")
if (receipt.status !== "prepared") fail("Receipt is not in a consumable state")
if (receipt.manifest_sha256 !== manifestHash) fail("Manifest changed after permission preparation")
if (Date.parse(receipt.expires_at) <= Date.now()) fail("Permission grant expired")

for (const field of ["operation_id", "parent_thread_id", "task_name", "environment_id"]) {
  if (receipt.bindings?.[field] !== manifest[field]) fail("Permission grant binding mismatch", { field })
}

const preparedRoots = receipt.effective?.child?.write_roots || []
if (preparedRoots.length !== effective.child.write_roots.length) fail("Child writable-root count changed after preparation")
for (let index = 0; index < preparedRoots.length; index += 1) {
  const before = preparedRoots[index]
  const now = effective.child.write_roots[index]
  if (
    before.real !== now.real ||
    before.dev !== now.dev ||
    before.ino !== now.ino ||
    before.mode !== now.mode ||
    before.ctime_ns !== now.ctime_ns ||
    before.birthtime_ns !== now.birthtime_ns
  ) {
    fail("Writable-root filesystem identity changed after preparation", { before, now })
  }
}

const state = fs.existsSync(stateFile) ? readJson(stateFile, "grant state") : { version: 1, consumed: {} }
if (state.consumed?.[receipt.grant_id]) fail("Permission grant has already been consumed", { grant_id: receipt.grant_id })
state.consumed ||= {}
state.consumed[receipt.grant_id] = {
  consumed_at: new Date().toISOString(),
  operation_id: manifest.operation_id,
  parent_thread_id: manifest.parent_thread_id,
  task_name: manifest.task_name,
  environment_id: manifest.environment_id,
  manifest_sha256: manifestHash,
}
atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`)
atomicWrite(receiptFile, `${JSON.stringify({ ...receipt, status: "consumed", consumed_at: state.consumed[receipt.grant_id].consumed_at }, null, 2)}\n`)
console.log(
  JSON.stringify(
    {
      status: "consumed",
      grant_id: receipt.grant_id,
      operation_id: manifest.operation_id,
      task_name: manifest.task_name,
      effective_child: effective.child,
      route: effective.route,
      state_file: stateFile,
    },
    null,
    2,
  ),
)
