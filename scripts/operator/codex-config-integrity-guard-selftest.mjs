import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-integrity-"))
const config = path.join(root, "config.toml")
const guard = path.join(process.cwd(), "scripts/operator/codex-config-integrity-guard.mjs")

function run(args, expectedStatus) {
  const result = spawnSync(process.execPath, [guard, "--codex-home", root, ...args], { encoding: "utf8" })
  if (result.status !== expectedStatus) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`Expected exit ${expectedStatus}, received ${result.status}`)
  }
  return JSON.parse(result.stdout)
}

try {
  fs.writeFileSync(config, '[sandbox_workspace_write]\nnetwork_access = true\n')
  const baseline = run(["--baseline"], 0)
  if (baseline.status !== "baseline_created") throw new Error("Baseline was not created")

  const healthy = run(["--verify", "--require-network-access", "true"], 0)
  if (healthy.status !== "ok") throw new Error("Healthy configuration did not verify")

  fs.writeFileSync(config, "[sandbox_workspace_write]\nnetwork_access = false\n")
  const downgraded = run(["--verify", "--require-network-access", "true"], 2)
  if (!downgraded.network_access_downgraded) throw new Error("Network downgrade was not detected")

  console.log("Codex config integrity guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
