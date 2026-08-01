import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPLACEMENTS = new Map([
  ["gpt-5.4-mini", "gpt-5.6-luna"],
  ["gpt-5.4", "gpt-5.6-terra"],
])
const RETIRING_PATTERN = /gpt-5\.4-mini|gpt-5\.4/g
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".operator-state",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
])
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".conf",
  ".env",
  ".ini",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
])
const CONTROL_PATHS = new Set([
  "config/operator-goal.json",
  "schemas/operator-goal.schema.json",
  "scripts/operator/validate-goal.mjs",
  "scripts/operator/model-retirement-migration.mjs",
  "scripts/operator/model-retirement-migration-selftest.mjs",
])
const GUIDED_PATH_PATTERNS = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:deploy|deployment|production|prod)(?:\/|\.|-|$)/i,
  /(^|\/)(?:secret|credential|billing)(?:s)?(?:\/|\.|-|$)/i,
  /(^|\/)managed_config\.toml$/i,
  /(^|\/)requirements\.toml$/i,
  /(^|\/)Dockerfile(?:\.|$)/i,
]

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

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function normalizeRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function isGuidedPath(relativePath) {
  return GUIDED_PATH_PATTERNS.some((pattern) => pattern.test(relativePath))
}

function isTextCandidate(file) {
  const extension = path.extname(file).toLowerCase()
  return TEXT_EXTENSIONS.has(extension) || path.basename(file).startsWith("Dockerfile")
}

function walk(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(fullPath)
        continue
      }
      if (entry.isFile() && isTextCandidate(fullPath)) files.push(fullPath)
    }
  }
  return files.sort()
}

function replaceRetiringModels(content) {
  return content.replace(RETIRING_PATTERN, (model) => REPLACEMENTS.get(model) || model)
}

function atomicWrite(file, content) {
  const stat = fs.statSync(file)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, { mode: stat.mode })
  fs.renameSync(temporary, file)
}

function scanAndPatch({ root, mode = "scan", receiptFile = null }) {
  const canonicalRoot = fs.realpathSync(root)
  const findings = []
  const patches = []
  const guided = []

  for (const file of walk(canonicalRoot)) {
    const content = fs.readFileSync(file, "utf8")
    const matches = [...content.matchAll(RETIRING_PATTERN)].map((match) => match[0])
    if (matches.length === 0) continue

    const relativePath = normalizeRelative(canonicalRoot, file)
    if (CONTROL_PATHS.has(relativePath)) continue
    const finding = {
      path: relativePath,
      models: [...new Set(matches)],
      before_sha256: sha256(content),
      classification: isGuidedPath(relativePath) ? "guided_intervention_required" : "autonomous_safe",
    }
    findings.push(finding)

    if (mode !== "apply-safe") continue
    if (finding.classification !== "autonomous_safe") {
      guided.push(finding)
      continue
    }

    const replacement = replaceRetiringModels(content)
    atomicWrite(file, replacement)
    const verified = fs.readFileSync(file, "utf8")
    if (RETIRING_PATTERN.test(verified)) throw new Error(`retiring model remained after patch: ${relativePath}`)
    RETIRING_PATTERN.lastIndex = 0
    const afterHash = sha256(verified)
    patches.push({
      ...finding,
      after_sha256: afterHash,
      replacements: Object.fromEntries(REPLACEMENTS),
      verified: afterHash === sha256(replacement),
    })
  }

  if (mode === "scan") guided.push(...findings.filter((finding) => finding.classification === "guided_intervention_required"))

  const result = {
    status:
      guided.length > 0
        ? "guided_intervention_required"
        : findings.length === 0
          ? "clean"
          : mode === "apply-safe"
            ? "patched"
            : "migration_required",
    mode,
    root: canonicalRoot,
    deadline: "2026-08-31",
    authentication_boundary: "chatgpt",
    automatic_model_selection: false,
    gateway: null,
    fallback_chain: [],
    findings,
    patches,
    guided_intervention: guided,
    required_state: [
      "task_id",
      "thread_id",
      "operation_id",
      "idempotency_key",
      "repository_sha",
      "diff_hash",
      "external_write_state",
    ],
  }

  if (receiptFile) {
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true })
    const temporary = `${receiptFile}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, receiptFile)
  }

  return result
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root || process.cwd())
  const mode = args.mode || "scan"
  if (!new Set(["scan", "apply-safe"]).has(mode)) {
    console.error("--mode must be scan or apply-safe")
    process.exit(64)
  }

  const receiptFile = args.receipt ? path.resolve(args.receipt) : null
  const result = scanAndPatch({ root, mode, receiptFile })
  console.log(JSON.stringify(result, null, 2))

  if (result.status === "guided_intervention_required") process.exit(75)
  if (args["fail-on-findings"] && result.findings.length > 0) process.exit(1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

export { CONTROL_PATHS, REPLACEMENTS, isGuidedPath, replaceRetiringModels, scanAndPatch }
