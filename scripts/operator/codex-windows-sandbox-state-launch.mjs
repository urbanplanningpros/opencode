import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
const takeFlag = (name) => {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}
const takeValue = (name) => {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const value = argv[index + 1]
  if (!value) {
    console.error(`${name} requires a value.`)
    process.exit(64)
  }
  argv.splice(index, 2)
  return value
}

const preflightOnly = takeFlag("--sandbox-state-preflight-only")
const repair = takeFlag("--repair-sandbox-state")
const confirmedStopped = takeFlag("--confirm-codex-stopped")
const confirmation = takeValue("--confirm")
const platform = process.env.OPERATOR_PLATFORM_OVERRIDE || process.platform
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const sandboxDir = path.join(codexHome, ".sandbox")
const statePath = path.join(sandboxDir, "deny_read_acl_state.json")
const maxBytes = 1024 * 1024

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

function inspect() {
  const base = {
    platform,
    codex_home: codexHome,
    state_path: statePath,
    status: "not_applicable",
    safe_to_launch: true,
    reason: null,
    sha256: null,
    size_bytes: null,
  }

  if (platform !== "win32") return base
  if (!fs.existsSync(statePath)) return { ...base, status: "absent" }

  const info = fs.lstatSync(statePath)
  if (info.isSymbolicLink()) {
    return { ...base, status: "blocked", safe_to_launch: false, reason: "state_path_is_symlink" }
  }
  if (!info.isFile()) {
    return { ...base, status: "blocked", safe_to_launch: false, reason: "state_path_is_not_file" }
  }
  if (info.size > maxBytes) {
    return {
      ...base,
      status: "blocked",
      safe_to_launch: false,
      reason: "state_file_exceeds_size_limit",
      size_bytes: info.size,
    }
  }

  const body = fs.readFileSync(statePath)
  const digest = hash(body)
  const common = { ...base, sha256: digest, size_bytes: body.length }
  if (body.length === 0) {
    return { ...common, status: "corrupt", safe_to_launch: false, reason: "empty_state_file" }
  }
  if (body.includes(0)) {
    return { ...common, status: "corrupt", safe_to_launch: false, reason: "nul_byte_in_state_file" }
  }

  try {
    const parsed = JSON.parse(body.toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...common, status: "corrupt", safe_to_launch: false, reason: "state_json_is_not_object" }
    }
  } catch {
    return { ...common, status: "corrupt", safe_to_launch: false, reason: "invalid_state_json" }
  }

  return { ...common, status: "valid" }
}

function print(result) {
  console.log(JSON.stringify(result, null, 2))
}

let result = inspect()

if (repair) {
  if (platform !== "win32") {
    console.error("Windows sandbox-state repair is only valid on Windows.")
    process.exit(64)
  }
  if (result.safe_to_launch) {
    console.error(`No corrupt Windows sandbox state requires repair: ${result.status}.`)
    process.exit(64)
  }
  if (!confirmedStopped) {
    console.error(
      "Refusing repair until Codex Desktop, CLI, app-server, and sandbox setup processes are stopped. Re-run with --confirm-codex-stopped after verifying that condition.",
    )
    process.exit(64)
  }
  const expected = `REPAIR_CODEX_SANDBOX_STATE:${result.sha256}`
  if (confirmation !== expected) {
    console.error(`Refusing repair without the exact confirmation token: ${expected}`)
    process.exit(64)
  }

  const current = inspect()
  if (current.sha256 !== result.sha256 || current.reason !== result.reason) {
    console.error("Sandbox state changed after inspection; inspect again before repair.")
    process.exit(75)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = `${statePath}.corrupt-${stamp}-${result.sha256.slice(0, 12)}.bak`
  fs.renameSync(statePath, backupPath)
  result = {
    ...result,
    status: "quarantined",
    safe_to_launch: false,
    backup_path: backupPath,
    next_step: "Run the normal Windows sandbox setup again, then rerun this guard before launching authoritative work.",
  }
  print(result)
  process.exit(0)
}

if (preflightOnly) {
  print(result)
  process.exit(result.safe_to_launch ? 0 : 78)
}

if (!result.safe_to_launch) {
  print(result)
  const token = result.sha256 ? `REPAIR_CODEX_SANDBOX_STATE:${result.sha256}` : "unavailable"
  console.error(
    `Refusing to start Codex because the Windows sandbox ACL state is ${result.status} (${result.reason}). Preserve the file as evidence. Stop Codex processes, then quarantine it with --repair-sandbox-state --confirm-codex-stopped --confirm '${token}'. Continue unrelated work through a separate approved state profile, guarded WSL, or the explicitly authorized local route.`,
  )
  process.exit(78)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const guardedLauncher = path.join(scriptDir, "codex-cache-safe-launch.mjs")
const child = spawn(process.execPath, [guardedLauncher, ...argv], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_WINDOWS_SANDBOX_STATE_GUARD_ACTIVE: platform === "win32" ? "1" : "0",
  },
  stdio: "inherit",
})

child.on("error", (error) => {
  console.error(`Unable to start the guarded Codex launcher: ${error.message}`)
  process.exit(70)
})
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
