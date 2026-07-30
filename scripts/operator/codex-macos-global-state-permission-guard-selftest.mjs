#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-macos-global-state-"))
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-macos-global-state-permission-guard.mjs")

function invoke(args, expectedExit, expectedStatus) {
  const result = spawnSync(process.execPath, [guard, ...args, "--json"], { encoding: "utf8" })
  if (result.status !== expectedExit) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`expected exit ${expectedExit}, got ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedStatus) throw new Error(`expected ${expectedStatus}, got ${output.status}`)
  return output
}

try {
  const codexHome = path.join(root, "codex-home")
  fs.mkdirSync(codexHome, { mode: 0o755 })
  const state = path.join(codexHome, ".codex-global-state.json")
  const backup = path.join(codexHome, ".codex-global-state.json.bak")
  fs.writeFileSync(state, "{}\n", { mode: 0o644 })
  fs.writeFileSync(backup, "{}\n", { mode: 0o644 })
  fs.chmodSync(codexHome, 0o755)
  fs.chmodSync(state, 0o644)
  fs.chmodSync(backup, 0o644)

  const drift = invoke(["--codex-home", codexHome], 75, "remediation_required")
  if (!drift.remediation.includes("set_codex_home_mode_0700")) throw new Error("directory permission drift not detected")
  if (!drift.remediation.includes("set_global_state_mode_0600:.codex-global-state.json")) {
    throw new Error("state permission drift not detected")
  }
  if (!drift.remediation.includes("set_global_state_mode_0600:.codex-global-state.json.bak")) {
    throw new Error("backup permission drift not detected")
  }

  invoke(["--codex-home", codexHome, "--repair"], 0, "compatible")
  const homeMode = fs.statSync(codexHome).mode & 0o777
  const stateMode = fs.statSync(state).mode & 0o777
  const backupMode = fs.statSync(backup).mode & 0o777
  if (homeMode !== 0o700) throw new Error(`expected CODEX_HOME 0700, got ${homeMode.toString(8)}`)
  if (stateMode !== 0o600) throw new Error(`expected state 0600, got ${stateMode.toString(8)}`)
  if (backupMode !== 0o600) throw new Error(`expected backup 0600, got ${backupMode.toString(8)}`)

  fs.unlinkSync(backup)
  fs.symlinkSync(path.join(root, "outside-state.json"), backup)
  const symlink = invoke(["--codex-home", codexHome], 64, "blocked")
  if (!symlink.blocked.includes("global_state_target_is_symlink:.codex-global-state.json.bak")) {
    throw new Error("symlinked backup was not blocked")
  }

  console.log("Codex macOS global-state permission guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
