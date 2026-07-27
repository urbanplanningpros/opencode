import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(scriptDir, "codex-runtime-isolation-launch.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-isolation-"))
const home = path.join(root, "home")
fs.mkdirSync(home, { recursive: true })

function run(extraEnv = {}) {
  return spawnSync(process.execPath, [launcher, "--isolation-preflight-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPERATOR_CODEX_BINARY: "codex",
      OPERATOR_CODEX_RUNTIME_VERSION: "codex-cli 0.145.0",
      ...extraEnv,
    },
  })
}

const first = run()
assert.equal(first.status, 0, first.stderr)
const firstOutput = JSON.parse(first.stdout)
assert.match(firstOutput.codex_home, /codex-cli-0\.145\.0$/)
assert.equal(firstOutput.runtime_version, "codex-cli 0.145.0")
assert.equal(fs.existsSync(firstOutput.marker_path), true)

const second = run()
assert.equal(second.status, 0, second.stderr)

const mismatch = run({
  CODEX_HOME: firstOutput.codex_home,
  OPERATOR_CODEX_RUNTIME_VERSION: "codex-cli 0.146.0-alpha.12",
})
assert.equal(mismatch.status, 64)
assert.match(mismatch.stderr, /Refusing to share CODEX_HOME across Codex runtimes/)

const shared = run({ CODEX_HOME: path.join(home, ".codex") })
assert.equal(shared.status, 64)
assert.match(shared.stderr, /Refusing the shared ~\/\.codex state directory/)

const unmarked = path.join(home, "existing-unmarked")
fs.mkdirSync(unmarked, { recursive: true })
fs.writeFileSync(path.join(unmarked, "state_5.sqlite"), "fixture")
const refusedAdoption = run({ CODEX_HOME: unmarked })
assert.equal(refusedAdoption.status, 64)
assert.match(refusedAdoption.stderr, /Refusing to adopt non-empty unmarked CODEX_HOME/)

const adopted = run({ CODEX_HOME: unmarked, OPERATOR_ADOPT_CODEX_HOME: "1" })
assert.equal(adopted.status, 0, adopted.stderr)
const adoptedOutput = JSON.parse(adopted.stdout)
assert.equal(adoptedOutput.safe, true)
assert.equal(fs.existsSync(path.join(unmarked, ".operator-codex-runtime.json")), true)

console.log("codex runtime isolation self-test passed")
