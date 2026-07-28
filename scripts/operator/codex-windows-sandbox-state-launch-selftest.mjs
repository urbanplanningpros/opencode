import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sandbox-state-guard-"))
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-windows-sandbox-state-launch.mjs")
const stateDir = path.join(dir, ".sandbox")
const statePath = path.join(stateDir, "deny_read_acl_state.json")
fs.mkdirSync(stateDir, { recursive: true })

function run(args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: dir,
      OPERATOR_PLATFORM_OVERRIDE: "win32",
      ...extraEnv,
    },
  })
}

let result = run(["--sandbox-state-preflight-only"])
if (result.status !== 0 || JSON.parse(result.stdout).status !== "absent") throw new Error("absent state did not pass")

fs.writeFileSync(statePath, JSON.stringify({ version: 1, entries: [] }))
result = run(["--sandbox-state-preflight-only"])
if (result.status !== 0 || JSON.parse(result.stdout).status !== "valid") throw new Error("valid state did not pass")

const nulBody = Buffer.alloc(128)
fs.writeFileSync(statePath, nulBody)
result = run(["--sandbox-state-preflight-only"])
if (result.status !== 78) throw new Error(`NUL state should fail with 78, got ${result.status}`)
const finding = JSON.parse(result.stdout)
if (finding.reason !== "nul_byte_in_state_file") throw new Error("NUL state reason mismatch")
if (!fs.existsSync(statePath)) throw new Error("preflight mutated corrupt state")

result = run(["--repair-sandbox-state", "--confirm", `REPAIR_CODEX_SANDBOX_STATE:${finding.sha256}`])
if (result.status !== 64) throw new Error("repair should require stopped-process confirmation")

result = run([
  "--repair-sandbox-state",
  "--confirm-codex-stopped",
  "--confirm",
  `REPAIR_CODEX_SANDBOX_STATE:${finding.sha256}`,
])
if (result.status !== 0) throw new Error(`repair failed: ${result.stderr}`)
const repaired = JSON.parse(result.stdout)
if (repaired.status !== "quarantined") throw new Error("repair status mismatch")
if (fs.existsSync(statePath)) throw new Error("corrupt state was not quarantined")
if (!fs.existsSync(repaired.backup_path)) throw new Error("quarantine backup missing")
if (!fs.readFileSync(repaired.backup_path).equals(nulBody)) throw new Error("quarantine backup content changed")

fs.writeFileSync(statePath, "{not-json")
result = run(["--sandbox-state-preflight-only"])
if (result.status !== 78 || JSON.parse(result.stdout).reason !== "invalid_state_json") {
  throw new Error("invalid JSON did not fail closed")
}

result = run(["--sandbox-state-preflight-only"], { OPERATOR_PLATFORM_OVERRIDE: "linux" })
if (result.status !== 0 || JSON.parse(result.stdout).status !== "not_applicable") {
  throw new Error("non-Windows route should be a no-op")
}

fs.rmSync(dir, { recursive: true, force: true })
console.log("codex Windows sandbox state guard self-test passed")
