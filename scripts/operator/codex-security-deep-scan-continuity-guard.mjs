import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) {
      args._.push(value)
      continue
    }
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

function fail(message, code = 2, details = {}) {
  console.error(JSON.stringify({ status: "blocked", message, ...details }, null, 2))
  process.exit(code)
}

function sha256Buffer(content) {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function sha256Json(value) {
  return sha256Buffer(Buffer.from(JSON.stringify(value)))
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function readJson(file) {
  const raw = fs.readFileSync(file)
  return { raw, value: JSON.parse(raw.toString("utf8")) }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`)
  return parsed
}

function isTerminalSetupRangeFailure(manifest) {
  const message = String(manifest?.failure?.message || "")
  const kind = String(manifest?.failure?.kind || "")
  return (
    manifest?.status === "failed" &&
    manifest?.setup?.completed === false &&
    manifest?.failure?.phase === "setup" &&
    (kind === "RangeError" || message.includes("Invalid string length")) &&
    Number(manifest?.dispatchedCount || 0) === 0 &&
    !manifest?.canonical
  )
}

function validateRoute(args) {
  const provider = String(args.provider || "openai")
  const model = String(args.model || "gpt-5.6-sol")
  const route = String(args.route || "authorized-local")
  const gateway = args.gateway === true ? "configured" : String(args.gateway || "")
  const fallbacks = args.fallbacks === true ? "configured" : String(args.fallbacks || "")

  if (provider !== "openai") fail("Only the explicitly pinned OpenAI provider is authorized", 78)
  if (!model || model.toLowerCase() === "auto") fail("An explicit OpenAI model must be pinned", 78)
  if (!model.startsWith("gpt-")) fail("The model identifier is not an approved explicit OpenAI route", 78)
  if (!new Set(["authorized-local", "direct-openai"]).has(route)) {
    fail("Route must be authorized-local or direct-openai", 78)
  }
  if (gateway && gateway !== "none" && gateway !== "null") fail("Model gateways are prohibited", 78)
  if (fallbacks && fallbacks !== "none" && fallbacks !== "[]" && fallbacks !== "null") {
    fail("Automatic fallback chains are prohibited", 78)
  }

  return {
    provider,
    model,
    route,
    automatic_model_selection: false,
    gateway: null,
    fallback_chain: [],
  }
}

function gitTrackedFiles(repo) {
  let output
  try {
    output = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "buffer" })
  } catch (error) {
    fail("Unable to inventory tracked files with git ls-files", 2, { error: String(error?.message || error) })
  }

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((relativePath) => {
      const absolutePath = path.join(repo, relativePath)
      let bytes = 0
      let type = "missing"
      try {
        const stat = fs.lstatSync(absolutePath)
        bytes = stat.size
        type = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other"
      } catch {
        // Keep the path in the plan so missing-worktree state is visible and reviewable.
      }
      return { path: relativePath.replaceAll("\\", "/"), bytes, type }
    })
}

function partitionFiles(files, maxFiles, maxBytes) {
  const chunks = []
  let current = []
  let bytes = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push({ files: current, bytes })
    current = []
    bytes = 0
  }

  for (const file of files) {
    const wouldExceedFiles = current.length > 0 && current.length + 1 > maxFiles
    const wouldExceedBytes = current.length > 0 && bytes + file.bytes > maxBytes
    if (wouldExceedFiles || wouldExceedBytes) flush()
    current.push(file)
    bytes += file.bytes
    if (file.bytes > maxBytes) flush()
  }
  flush()

  return chunks.map((chunk, index) => {
    const scopeFiles = chunk.files.map((file) => file.path)
    return {
      chunk_index: index + 1,
      chunk_key: sha256Json(scopeFiles),
      file_count: scopeFiles.length,
      total_bytes: chunk.bytes,
      contains_oversized_single_file: chunk.files.length === 1 && chunk.files[0].bytes > maxBytes,
      scope_files: scopeFiles,
    }
  })
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] || "plan"
if (command !== "plan") fail(`Unsupported command: ${command}`)

const manifestFile = path.resolve(String(args.manifest || ""))
const repo = path.resolve(String(args.repo || process.cwd()))
const operationId = String(args["operation-id"] || "").trim()
const outputFile = path.resolve(
  String(args.output || path.join(repo, ".operator-state", "codex-security-deep-scan-continuity-plan.json")),
)
const maxFiles = positiveInteger(args["max-files"], 250, "max-files")
const maxBytes = positiveInteger(args["max-bytes"], 32 * 1024 * 1024, "max-bytes")
const route = validateRoute(args)

if (!operationId) fail("--operation-id is required")
if (!manifestFile || !fs.existsSync(manifestFile)) fail("--manifest must point to an existing JSON file")
if (!fs.existsSync(repo)) fail("--repo must point to an existing repository")

const { raw: manifestRaw, value: manifest } = readJson(manifestFile)
if (!isTerminalSetupRangeFailure(manifest)) {
  console.log(
    JSON.stringify(
      {
        status: "no_guarded_fallback_needed",
        operation_id: operationId,
        scan_id: manifest?.scanId || null,
        reason: "Manifest does not match the terminal setup-phase RangeError signature",
      },
      null,
      2,
    ),
  )
  process.exit(3)
}

const files = gitTrackedFiles(repo)
if (files.length === 0) fail("Repository inventory is empty; refusing to create a meaningless fallback scan plan", 2)
const chunks = partitionFiles(files, maxFiles, maxBytes)
const repoHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const worktreeRoot = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

const plan = {
  schema_version: 1,
  status: "fallback_plan_ready",
  created_at: new Date().toISOString(),
  operation_id: operationId,
  original_scan: {
    scan_id: manifest.scanId || null,
    workflow_version: manifest.workflowVersion || null,
    manifest_file: manifestFile,
    manifest_sha256: sha256Buffer(manifestRaw),
    terminal: true,
    resumable: false,
    retry_original_scan: false,
    failure: manifest.failure,
  },
  repository: {
    worktree_root: worktreeRoot,
    head_sha: repoHead,
    tracked_file_count: files.length,
    tracked_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  },
  routing: route,
  chunk_policy: {
    max_files: maxFiles,
    max_bytes: maxBytes,
    chunk_count: chunks.length,
  },
  child_scans: chunks.map((chunk) => ({
    ...chunk,
    child_operation_id: `${operationId}:security-scan:${String(chunk.chunk_index).padStart(4, "0")}`,
    must_create_new_scan_id: true,
    must_not_import_original_session: true,
    expected_route: route,
  })),
  reconciliation: {
    require_terminal_receipt_per_child: true,
    accepted_terminal_states: ["completed", "failed", "cancelled", "timed_out"],
    dedupe_key_fields: ["severity", "rule_id", "path", "line", "evidence_sha256"],
    merge_only_after_all_children_terminal: true,
    preserve_original_failure_manifest: true,
  },
  action_sequence: [
    "Do not retry or resume the terminal original scan ID.",
    "Create one independent bounded scan per child_scans entry using its exact scope_files list.",
    "Pin the provider, model, route, worktree root, and repository HEAD from this plan before each scan.",
    "Record a terminal receipt for every child operation and reconcile uncertain side effects before retrying.",
    "Deduplicate and merge findings only after every child reaches a terminal state.",
    "Continue unrelated builds, deployments, connectors, and automations while the scan is partitioned.",
  ],
}

atomicWrite(outputFile, `${JSON.stringify(plan, null, 2)}\n`)
console.log(JSON.stringify({ ...plan, output_file: outputFile }, null, 2))
