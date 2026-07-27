import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cua-worker-guard-"))
const script = path.resolve(import.meta.dirname, "codex-cua-worker-guard.mjs")

function runFixture(name, lines, extraArgs = []) {
  const file = path.join(root, `${name}.ps`)
  const state = path.join(root, `${name}-state`)
  fs.writeFileSync(file, `${lines.join("\n")}\n`)
  return spawnSync(process.execPath, [script, "--process-list-file", file, "--state-dir", state, "--json", ...extraArgs], {
    encoding: "utf8",
  })
}

const appServer = "100 1 S 02:10:00 65536 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled"
const leakingWorkers = Array.from({ length: 9 }, (_, index) => {
  const pid = 200 + index
  return `${pid} 100 S 01:30:00 8192 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl --fixture-secret-${index}`
})
const blocked = runFixture("blocked", [appServer, ...leakingWorkers])
if (blocked.status !== 2) throw new Error(`Expected blocked fixture to exit 2, got ${blocked.status}: ${blocked.stderr}`)
const blockedResult = JSON.parse(blocked.stdout)
if (blockedResult.status !== "recovery_required") throw new Error("Blocked fixture did not require recovery")
if (blockedResult.workers.total !== 9) throw new Error(`Expected 9 workers, got ${blockedResult.workers.total}`)
if (!blockedResult.block_new_desktop_automations) throw new Error("Blocked fixture did not close new Desktop automation admission")
if (blocked.stdout.includes("fixture-secret")) throw new Error("Guard leaked worker command arguments into JSON output")
if (!fs.existsSync(blockedResult.snapshot_file)) throw new Error("Blocked fixture did not create a snapshot")

const healthyWorker = "201 100 S 00:01:00 8192 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"
const healthy = runFixture("healthy", [appServer, healthyWorker])
if (healthy.status !== 0) throw new Error(`Expected healthy fixture to exit 0, got ${healthy.status}: ${healthy.stderr}`)
const healthyResult = JSON.parse(healthy.stdout)
if (healthyResult.status !== "healthy") throw new Error("Healthy fixture was not healthy")
if (healthyResult.workers.total !== 1) throw new Error(`Expected 1 worker, got ${healthyResult.workers.total}`)

const scoped = runFixture("scoped", [
  appServer,
  "101 1 S 00:20:00 65536 /Applications/ChatGPT.app/Contents/Resources/codex app-server",
  ...leakingWorkers,
  "300 101 S 00:05:00 8192 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
], ["--pid", "101"])
if (scoped.status !== 0) throw new Error(`Expected scoped fixture to exit 0, got ${scoped.status}: ${scoped.stderr}`)
const scopedResult = JSON.parse(scoped.stdout)
if (scopedResult.workers.total !== 1) throw new Error(`PID scoping failed; expected 1 worker, got ${scopedResult.workers.total}`)

console.log("Codex CUA worker guard self-test passed")
