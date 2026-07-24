import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const repoRoot = path.resolve(import.meta.dirname, "../..")

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) {
      args._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

export function stateRoot(args = {}) {
  return path.resolve(args["state-dir"] || process.env.OPERATOR_STATE_DIR || path.join(repoRoot, ".operator-state"))
}

export function nowIso() {
  return new Date().toISOString()
}

export function randomId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`
}
