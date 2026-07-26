import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

function within(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

let raw = ""
for await (const chunk of process.stdin) raw += chunk

let input
try {
  input = JSON.parse(raw)
} catch (error) {
  console.error(`Atomic edit input must be valid JSON: ${error.message}`)
  process.exit(64)
}

if (typeof input.path !== "string" || input.path.trim() === "") {
  console.error("Atomic edit requires a non-empty path")
  process.exit(64)
}
if (typeof input.content_base64 !== "string") {
  console.error("Atomic edit requires content_base64")
  process.exit(64)
}
if (typeof input.expected_sha256 !== "string" || input.expected_sha256.trim() === "") {
  console.error("Atomic edit requires expected_sha256, or the literal 'missing' for an approved create")
  process.exit(64)
}

const target = path.resolve(input.path)
const parent = path.dirname(target)
if (!fs.existsSync(parent)) {
  console.error(`Atomic edit parent directory does not exist: ${parent}`)
  process.exit(66)
}

const resolvedParent = fs.realpathSync(parent)
const allowedRoots = [process.cwd(), ...(process.env.OPERATOR_ALLOWED_WRITE_ROOTS || "").split(path.delimiter)]
  .filter(Boolean)
  .map((root) => fs.realpathSync(path.resolve(root)))
if (!allowedRoots.some((root) => within(root, resolvedParent))) {
  console.error(`Atomic edit target is outside approved write roots: ${target}`)
  process.exit(77)
}

const exists = fs.existsSync(target)
if (exists && fs.lstatSync(target).isSymbolicLink()) {
  console.error("Atomic edit refuses symbolic-link targets")
  process.exit(77)
}
if (!exists && input.allow_create !== true) {
  console.error("Atomic edit target does not exist and allow_create is not true")
  process.exit(66)
}
if (!exists && input.expected_sha256 !== "missing") {
  console.error("Creating a file requires expected_sha256='missing'")
  process.exit(65)
}

const before = exists ? fs.readFileSync(target) : null
const beforeHash = before ? sha256(before) : "missing"
if (beforeHash !== input.expected_sha256) {
  console.error(`Atomic edit rejected stale input: expected ${input.expected_sha256}, found ${beforeHash}`)
  process.exit(65)
}

let content
try {
  content = Buffer.from(input.content_base64, "base64")
} catch (error) {
  console.error(`Unable to decode content_base64: ${error.message}`)
  process.exit(64)
}
const maxBytes = Number(process.env.OPERATOR_ATOMIC_EDIT_MAX_BYTES || 10 * 1024 * 1024)
if (!Number.isFinite(maxBytes) || maxBytes <= 0 || content.length > maxBytes) {
  console.error(`Atomic edit content exceeds the approved ${maxBytes}-byte limit`)
  process.exit(64)
}

const intendedHash = sha256(content)
const mode = exists ? fs.statSync(target).mode : 0o600
const temp = path.join(parent, `.${path.basename(target)}.operator-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`)
let descriptor
try {
  descriptor = fs.openSync(temp, "wx", mode)
  fs.writeFileSync(descriptor, content)
  fs.fsyncSync(descriptor)
  fs.closeSync(descriptor)
  descriptor = undefined
  fs.renameSync(temp, target)
} catch (error) {
  if (descriptor !== undefined) fs.closeSync(descriptor)
  if (fs.existsSync(temp)) fs.rmSync(temp, { force: true })
  console.error(`Atomic edit failed without using a system temporary directory: ${error.message}`)
  process.exit(74)
}

const after = fs.readFileSync(target)
const afterHash = sha256(after)
if (afterHash !== intendedHash) {
  console.error(`Atomic edit verification failed: expected ${intendedHash}, found ${afterHash}`)
  process.exit(74)
}

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    path: target,
    before_sha256: beforeHash,
    after_sha256: afterHash,
    bytes: after.length,
    same_directory_temp: true,
  })}\n`,
)
