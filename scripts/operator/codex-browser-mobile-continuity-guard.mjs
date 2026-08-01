import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (!value.startsWith("--")) {
      args._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      i += 1
    }
  }
  return args
}

function emit(value, code = 0) {
  const target = code === 0 ? console.log : console.error
  target(JSON.stringify(value, null, 2))
  process.exit(code)
}

function fail(message, code = 78, details = {}) {
  emit({ status: "blocked", message, ...details }, code)
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function sha256File(file) {
  const hash = crypto.createHash("sha256")
  const fd = fs.openSync(file, "r")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest("hex")
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function sanitizeId(value) {
  const output = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!output) fail("operation id cannot be sanitized into an artifact-safe identifier")
  return output.slice(0, 96)
}

function validateRoute(args) {
  const provider = String(args.provider || "openai")
  const model = String(args.model || "gpt-5.6-sol")
  const route = String(args.route || "authorized-local")
  const gateway = String(args.gateway || "none")
  const fallback = String(args.fallbacks || "none")

  if (provider !== "openai") fail("Only the explicitly pinned OpenAI provider is authorized")
  if (!model.startsWith("gpt-") || model.toLowerCase() === "auto") {
    fail("An explicit approved OpenAI model must be pinned")
  }
  if (!new Set(["authorized-local", "direct-openai"]).has(route)) {
    fail("Route must be authorized-local or direct-openai")
  }
  if (!new Set(["", "none", "null"]).has(gateway)) fail("Model gateways are prohibited")
  if (!new Set(["", "none", "null", "[]"]).has(fallback)) fail("Automatic fallback chains are prohibited")

  return {
    provider,
    model,
    route,
    automatic_model_selection: false,
    gateway: null,
    fallback_chain: [],
  }
}

function browserPlan(args) {
  const operationId = String(args["operation-id"] || "").trim()
  if (!operationId) fail("--operation-id is required", 2)
  const routing = validateRoute(args)
  const build = String(args.build || "unknown")

  emit({
    schema_version: 1,
    status: "browser_download_shim_ready",
    operation_id: operationId,
    affected_build: build,
    routing,
    runtime_probe: [
      "const proto = Object.getPrototypeOf(download)",
      "const hasPath = proto && Object.getOwnPropertyNames(proto).includes('path')",
      "if (!hasPath || typeof download.path !== 'function') return { status: 'path_unavailable' }",
      "const downloadedPath = await download.path({ timeoutMs: 10000 })",
      "return { status: downloadedPath ? 'path_ready' : 'path_unavailable', downloadedPath }",
    ],
    safeguards: {
      click_download_once: true,
      preserve_download_event_identity: true,
      prohibit_broad_filesystem_search: true,
      prohibit_duplicate_download_retry: true,
      require_local_hash_receipt_before_follow_on_actions: true,
    },
    action_sequence: [
      "Register waitForEvent('download') before the single download-triggering click.",
      "After the event resolves, inspect the returned object's prototype for the runtime path method.",
      "Call path() at most once; do not repeat the click when path is null or unavailable.",
      "Pass the returned path to download-receipt with an explicit allowed root and artifact directory.",
      "Allow upload, parsing, or connector handoff only after the hash-bound receipt is written.",
      "If path is unavailable, defer only the artifact-dependent segment and keep unrelated work running.",
    ],
  })
}

function downloadReceipt(args) {
  const operationId = String(args["operation-id"] || "").trim()
  if (!operationId) fail("--operation-id is required", 2)
  const routing = validateRoute(args)
  const sourceInput = String(args["source-path"] || "")
  const artifactInput = String(args["artifact-dir"] || "")
  const rootsInput = String(args["allowed-roots-json"] || "")
  const expectedFilename = args["expected-filename"] ? String(args["expected-filename"]) : null
  if (!sourceInput || !artifactInput || !rootsInput) {
    fail("--source-path, --artifact-dir, and --allowed-roots-json are required", 2)
  }

  let allowedRoots
  try {
    allowedRoots = JSON.parse(rootsInput)
  } catch {
    fail("--allowed-roots-json must be a JSON array", 2)
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0 || allowedRoots.some((item) => typeof item !== "string")) {
    fail("--allowed-roots-json must contain one or more string paths", 2)
  }

  const sourceLstat = fs.lstatSync(sourceInput)
  if (sourceLstat.isSymbolicLink()) fail("Downloaded artifact path is a symlink; refusing ambiguous capture")
  if (!sourceLstat.isFile()) fail("Downloaded artifact path is not a regular file")
  const source = fs.realpathSync(sourceInput)
  const canonicalRoots = allowedRoots.map((root) => fs.realpathSync(root))
  if (!canonicalRoots.some((root) => isWithin(source, root))) {
    fail("Downloaded artifact is outside every explicitly allowed root", 78, { source, allowed_roots: canonicalRoots })
  }

  const basename = path.basename(source)
  if (expectedFilename && basename !== expectedFilename) {
    fail("Downloaded filename does not match the expected filename", 75, { expected: expectedFilename, actual: basename })
  }

  const artifactDir = path.resolve(artifactInput)
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 })
  const hash = sha256File(source)
  const size = fs.statSync(source).size
  const destinationName = `${sanitizeId(operationId)}-${hash.slice(0, 16)}-${basename}`
  const destination = path.join(artifactDir, destinationName)
  const receiptFile = path.join(artifactDir, `${destinationName}.receipt.json`)

  if (fs.existsSync(destination)) {
    const destinationHash = sha256File(destination)
    if (destinationHash !== hash) fail("Existing artifact destination has a conflicting hash")
  } else {
    const temp = `${destination}.${process.pid}.${Date.now()}.tmp`
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(temp, 0o600)
    const copiedHash = sha256File(temp)
    if (copiedHash !== hash) {
      fs.unlinkSync(temp)
      fail("Artifact hash changed during capture")
    }
    fs.renameSync(temp, destination)
  }

  const receipt = {
    schema_version: 1,
    status: "artifact_captured",
    created_at: new Date().toISOString(),
    operation_id: operationId,
    routing,
    download: {
      source_path: source,
      source_path_sha256: crypto.createHash("sha256").update(source).digest("hex"),
      basename,
      bytes: size,
      sha256: hash,
      destination,
      duplicate_download_retry_permitted: false,
    },
    follow_on_authority: {
      parse: true,
      hash_verified_upload: true,
      broad_filesystem_search: false,
      repeat_browser_click: false,
    },
  }
  atomicWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  emit({ ...receipt, receipt_file: receiptFile })
}

function mobileProjectCheck(args) {
  const operationId = String(args["operation-id"] || "").trim()
  if (!operationId) fail("--operation-id is required", 2)
  const routing = validateRoute(args)
  const authoritativeFile = String(args.authoritative || "")
  const selectedFile = String(args.selected || "")
  if (!authoritativeFile || !selectedFile) fail("--authoritative and --selected JSON files are required", 2)

  const authoritative = readJson(authoritativeFile)
  const selected = readJson(selectedFile)
  const requiredFields = ["project_id", "host_id", "worktree_root", "head_sha"]
  const missingAuthoritative = requiredFields.filter((field) => !authoritative[field])
  const missingSelected = requiredFields.filter((field) => !selected[field])
  if (missingAuthoritative.length || missingSelected.length) {
    fail("Mobile project selection lacks immutable destination identity", 75, {
      missing_authoritative: missingAuthoritative,
      missing_selected: missingSelected,
      action: "Use the authoritative Desktop host or exact known thread UUID; do not mutate by project name.",
    })
  }
  if (authoritative.present === false) {
    fail("The selected project is absent or deleted in the authoritative host catalog", 75, {
      project_id: authoritative.project_id,
      action: "Block mobile mutation and use an existing exact thread only for read/reconciliation.",
    })
  }

  const mismatches = requiredFields
    .filter((field) => pathLike(field) ? path.resolve(String(authoritative[field])) !== path.resolve(String(selected[field])) : String(authoritative[field]) !== String(selected[field]))
    .map((field) => ({ field, authoritative: authoritative[field], selected: selected[field] }))

  if (mismatches.length) {
    emit({
      schema_version: 1,
      status: "mobile_catalog_untrusted",
      operation_id: operationId,
      routing,
      mismatches,
      mutation_authority: false,
      approved_continuity: [
        "Use the exact existing thread UUID on the verified Desktop host when available.",
        "Otherwise create a project-scoped task directly from Desktop or pinned Codex CLI on the authoritative worktree.",
        "Preserve the operation ID and reconcile any uncertain writes before continuing.",
      ],
      prohibited: ["project-name-only routing", "projectless retry", "new task from stale mobile catalog", "automatic model selection"],
    }, 75)
  }

  emit({
    schema_version: 1,
    status: "mobile_destination_verified",
    operation_id: operationId,
    routing,
    destination: Object.fromEntries(requiredFields.map((field) => [field, authoritative[field]])),
    display_name_authoritative: authoritative.display_name || null,
    display_name_selected: selected.display_name || null,
    note: "Display names are non-authoritative; mutation authority comes only from exact host/project/worktree/HEAD identity.",
    mutation_authority: true,
  })
}

function pathLike(field) {
  return field === "worktree_root"
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
if (command === "browser-plan") browserPlan(args)
else if (command === "download-receipt") downloadReceipt(args)
else if (command === "mobile-project-check") mobileProjectCheck(args)
else fail("Use browser-plan, download-receipt, or mobile-project-check", 2)
