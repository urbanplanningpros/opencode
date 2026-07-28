import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const argv = process.argv.slice(2)

function value(name) {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const next = argv[index + 1]
  if (!next || next.startsWith("--")) return ""
  return next
}

function has(name) {
  return argv.includes(name)
}

function fail(message, code = 2, details = {}) {
  console.error(JSON.stringify({ status: "blocked", reason: message, ...details }, null, 2))
  process.exit(code)
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function normalizedRoot(input) {
  const resolved = path.resolve(input)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    fail("project_root_missing_or_not_directory", 64)
  }
  const real = fs.realpathSync.native(resolved)
  return process.platform === "win32" ? real.toLowerCase() : real
}

function ensurePrivateDirectory(root, target) {
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("draft_directory_outside_project", 64)

  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) fail("draft_directory_symlink_rejected", 64, { component: part })
      if (!stat.isDirectory()) fail("draft_directory_component_not_directory", 64, { component: part })
      continue
    }
    fs.mkdirSync(current, { mode: 0o700 })
  }
  fs.chmodSync(target, 0o700)
}

function atomicWrite(file, data, mode = 0o600) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  fs.writeFileSync(temp, data, { mode })
  fs.renameSync(temp, file)
  fs.chmodSync(file, mode)
}

const projectRoot = normalizedRoot(value("--project-root") || process.cwd())
const projectHash = sha256(projectRoot)
const draftDir = path.join(projectRoot, ".operator", "codex-drafts")
const draftPath = path.join(draftDir, "new-conversation.md")
const metadataPath = path.join(draftDir, "new-conversation.json")
const maxBytes = Number(value("--max-bytes") || process.env.OPERATOR_CODEX_DRAFT_MAX_BYTES || 256 * 1024)

if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("invalid_max_bytes", 64)

const writeFile = value("--write")
const writeStdin = has("--stdin")
if (writeFile !== null && writeStdin) fail("choose_write_file_or_stdin", 64)

if (writeFile !== null || writeStdin) {
  let content
  if (writeFile !== null) {
    if (!writeFile) fail("missing_write_file", 64)
    const inputPath = path.resolve(writeFile)
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) fail("draft_input_missing", 64)
    content = fs.readFileSync(inputPath)
  } else {
    content = fs.readFileSync(0)
  }

  if (content.length === 0) fail("draft_is_empty", 64)
  if (content.length > maxBytes) fail("draft_exceeds_size_limit", 64, { bytes: content.length, max_bytes: maxBytes })

  ensurePrivateDirectory(projectRoot, draftDir)
  atomicWrite(draftPath, content)
  const metadata = {
    schema_version: 1,
    project_name: path.basename(projectRoot),
    project_root_sha256: projectHash,
    draft_sha256: sha256(content),
    bytes: content.length,
    updated_at: new Date().toISOString(),
  }
  atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  console.log(
    JSON.stringify(
      {
        status: "written",
        project_name: metadata.project_name,
        project_root_sha256: projectHash,
        draft_sha256: metadata.draft_sha256,
        bytes: metadata.bytes,
        draft_path: path.relative(projectRoot, draftPath),
        metadata_path: path.relative(projectRoot, metadataPath),
        next_step: "Verify this receipt immediately before pasting the draft into the matching Codex project composer.",
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

if (!fs.existsSync(draftPath) || !fs.existsSync(metadataPath)) fail("project_draft_missing", 2)
if (fs.lstatSync(draftPath).isSymbolicLink() || fs.lstatSync(metadataPath).isSymbolicLink()) {
  fail("draft_symlink_rejected", 2)
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"))
const content = fs.readFileSync(draftPath)
const actualHash = sha256(content)
const reasons = []
if (metadata.schema_version !== 1) reasons.push("unsupported_schema_version")
if (metadata.project_root_sha256 !== projectHash) reasons.push("project_identity_mismatch")
if (metadata.draft_sha256 !== actualHash) reasons.push("draft_hash_mismatch")
if (metadata.bytes !== content.length) reasons.push("draft_size_mismatch")

if (reasons.length > 0) {
  fail("project_draft_verification_failed", 2, {
    reasons,
    expected_project_root_sha256: projectHash,
    recorded_project_root_sha256: metadata.project_root_sha256 || null,
    actual_draft_sha256: actualHash,
    recorded_draft_sha256: metadata.draft_sha256 || null,
  })
}

console.log(
  JSON.stringify(
    {
      status: "verified",
      project_name: metadata.project_name,
      project_root_sha256: projectHash,
      draft_sha256: actualHash,
      bytes: content.length,
      draft_path: path.relative(projectRoot, draftPath),
      metadata_path: path.relative(projectRoot, metadataPath),
      safe_to_paste_into_matching_project: true,
      safe_to_reuse_in_another_project: false,
    },
    null,
    2,
  ),
)
