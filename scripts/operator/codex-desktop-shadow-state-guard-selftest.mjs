import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shadow-state-"))
const script = path.join(import.meta.dirname, "codex-desktop-shadow-state-guard.mjs")

function run(name, values = {}) {
  const directory = path.join(root, name)
  const evidence = path.join(directory, "evidence")
  fs.mkdirSync(directory, { recursive: true })
  const args = [script, "--json", "--state-dir", evidence]
  for (const [key, value] of Object.entries(values)) args.push(`--${key}`, value)
  const result = spawnSync(process.execPath, args, { encoding: "utf8" })
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  }
}

const defaultHome = path.join(root, "default-profile")
fs.mkdirSync(path.join(defaultHome, "sqlite"), { recursive: true })
fs.writeFileSync(path.join(defaultHome, "sqlite", "codex-dev.db"), "default-profile-state")

const defaultResult = run("default", {
  "default-codex-home": defaultHome,
  "codex-home": defaultHome,
})
assert.equal(defaultResult.status, 0, defaultResult.stderr)
assert.equal(defaultResult.json.status, "default_profile")
assert.equal(defaultResult.json.isolation.safe_to_launch_desktop, true)

const customClean = path.join(root, "custom-clean")
const unusedDefault = path.join(root, "unused-default")
fs.mkdirSync(customClean, { recursive: true })

const cleanResult = run("clean", {
  "default-codex-home": unusedDefault,
  "codex-home": customClean,
})
assert.equal(cleanResult.status, 0, cleanResult.stderr)
assert.equal(cleanResult.json.status, "isolated_profile_clean")
assert.equal(cleanResult.json.shadow_database.exists, false)

const customBlocked = path.join(root, "custom-blocked")
const sharedDefault = path.join(root, "shared-default")
const sharedDatabase = path.join(sharedDefault, "sqlite", "codex-dev.db")
fs.mkdirSync(customBlocked, { recursive: true })
fs.mkdirSync(path.dirname(sharedDatabase), { recursive: true })
fs.writeFileSync(sharedDatabase, "preserve-this-state")
const before = fs.readFileSync(sharedDatabase, "utf8")

const blockedResult = run("blocked", {
  "default-codex-home": sharedDefault,
  "codex-home": customBlocked,
})
assert.equal(blockedResult.status, 75, blockedResult.stderr)
assert.equal(blockedResult.json.status, "desktop_admission_blocked")
assert.equal(blockedResult.json.isolation.safe_to_launch_desktop, false)
assert.equal(blockedResult.json.isolation.safe_to_use_guarded_cli, true)
assert.equal(fs.readFileSync(sharedDatabase, "utf8"), before)
assert.ok(fs.existsSync(blockedResult.json.evidence_file))

const wrongTypeDefault = path.join(root, "wrong-type-default")
const wrongTypeShadow = path.join(wrongTypeDefault, "sqlite", "codex-dev.db")
const customWrongType = path.join(root, "custom-wrong-type")
fs.mkdirSync(wrongTypeShadow, { recursive: true })
fs.mkdirSync(customWrongType, { recursive: true })

const wrongTypeResult = run("wrong-type", {
  "default-codex-home": wrongTypeDefault,
  "codex-home": customWrongType,
})
assert.equal(wrongTypeResult.status, 75, wrongTypeResult.stderr)
assert.ok(wrongTypeResult.json.reasons.includes("shadow_database_type=directory"))

const relativeResult = run("relative", {
  "default-codex-home": defaultHome,
  "codex-home": "relative-profile",
})
assert.equal(relativeResult.status, 2)
assert.match(relativeResult.stderr, /absolute path/)

fs.rmSync(root, { recursive: true, force: true })
console.log("codex-desktop-shadow-state-guard self-test passed")
