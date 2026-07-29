import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

if (!process.versions.bun) {
  console.error("Run this self-test with Bun.")
  process.exit(69)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-guard-"))
const wrapper = path.resolve("scripts/operator/codex-hook-policy-safe-launch.mjs")

function run(args, codexHome) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPERATOR_CODEX_SKIP_SQLITE_LOCK_GUARD: "1",
    },
    encoding: "utf8",
  })
}

try {
  const cleanHome = path.join(root, "clean")
  fs.mkdirSync(cleanHome, { recursive: true })
  fs.writeFileSync(path.join(cleanHome, "config.toml"), "[features]\nhooks = false\n")

  const clean = run(["--dry-run", "--", "exec", "--ephemeral", "-"], cleanHome)
  if (clean.status !== 0) {
    throw new Error(`clean dry-run failed: ${clean.stderr || clean.stdout}`)
  }
  const receipt = JSON.parse(clean.stdout)
  const hookDisableIndex = receipt.args.findIndex((value, index) => value === "hooks" && receipt.args[index - 1] === "--disable")
  if (hookDisableIndex === -1) throw new Error("dry-run receipt did not contain --disable hooks")

  const cliOverride = run(["--dry-run", "--", "--enable", "hooks", "exec", "-"], cleanHome)
  if (cliOverride.status !== 64) {
    throw new Error(`CLI hook enable was not rejected with exit 64: ${cliOverride.status}`)
  }

  const configHome = path.join(root, "config-enabled")
  fs.mkdirSync(configHome, { recursive: true })
  fs.writeFileSync(path.join(configHome, "config.toml"), "[features]\nhooks = true\n")
  const configOverride = run(["--dry-run", "--", "exec", "-"], configHome)
  if (configOverride.status !== 64) {
    throw new Error(`config hook enable was not rejected with exit 64: ${configOverride.status}`)
  }

  console.log("Codex hook policy guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
