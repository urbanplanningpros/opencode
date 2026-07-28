#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(scriptDir, "codex-goal-authority-launch.mjs")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-authority-"))
const codexHome = path.join(tempRoot, "codex-home")
fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })

const baseEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_CONFIG_PATH: path.join(codexHome, "config.toml"),
  OPERATOR_PLATFORM_OVERRIDE: "linux",
  OPERATOR_CODEX_BINARY: process.execPath,
  OPERATOR_CODEX_QUOTA_SAFE_MODEL: "gpt-5.6-luna",
}

function run(args) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: path.resolve(scriptDir, "../.."),
    env: baseEnv,
    encoding: "utf8",
  })
}

try {
  const dryRun = run(["--dry-run", "--", "exec", "--ephemeral", "-"])
  assert.equal(dryRun.status, 0, dryRun.stderr)
  const summary = JSON.parse(dryRun.stdout)
  const disablePairs = summary.args
    .map((value, index) => [value, summary.args[index + 1]])
    .filter(([value]) => value === "--disable")
  assert.ok(
    disablePairs.some(([, feature]) => feature === "goals"),
    "guarded Codex arguments must disable goals",
  )

  const enableFlag = run(["--", "--enable", "goals", "exec", "--ephemeral", "-"])
  assert.equal(enableFlag.status, 64)
  assert.match(enableFlag.stderr, /Refusing to enable Codex Goals/)

  const configOverride = run(["--", "-c", "features.goals=true", "exec", "--ephemeral", "-"])
  assert.equal(configOverride.status, 64)
  assert.match(configOverride.stderr, /Refusing to enable Codex Goals/)

  console.log("Codex Goal authority guard self-test passed.")
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
