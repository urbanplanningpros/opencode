import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
const takeFlag = (name) => {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}

const preflightOnly = takeFlag("--isolation-preflight-only")
const dryRun = argv.includes("--dry-run")
const binary = process.env.OPERATOR_CODEX_BINARY || process.env.CODEX_BINARY || "codex"
const explicitVersion = (process.env.OPERATOR_CODEX_RUNTIME_VERSION || "").trim()

function probeRuntimeVersion() {
  if (explicitVersion) return explicitVersion
  if (dryRun) return "dry-run-unprobed"

  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5000,
  })
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split(/\r?\n/).find(Boolean) || ""
  if (result.error || result.status !== 0 || !output) {
    const detail = result.error?.message || `exit ${result.status ?? "unknown"}`
    console.error(`Unable to identify the Codex runtime before state isolation (${detail}).`)
    process.exit(69)
  }
  return output
}

function sanitizeProfile(value) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  if (!normalized) {
    console.error("Unable to derive a safe Codex state profile name.")
    process.exit(64)
  }
  return normalized
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, file)
}

const runtimeVersion = probeRuntimeVersion()
const profile = process.env.OPERATOR_CODEX_STATE_PROFILE || sanitizeProfile(runtimeVersion)
if (!/^[A-Za-z0-9._-]{1,96}$/.test(profile)) {
  console.error("OPERATOR_CODEX_STATE_PROFILE must contain only letters, numbers, dots, underscores, or hyphens.")
  process.exit(64)
}

const home = os.homedir()
const legacySharedHome = path.resolve(path.join(home, ".codex"))
const defaultIsolatedHome = path.resolve(path.join(home, ".codex-operator", profile))
const codexHome = path.resolve(process.env.CODEX_HOME || defaultIsolatedHome)
if (codexHome === legacySharedHome) {
  console.error(
    "Refusing the shared ~/.codex state directory. Use a runtime-specific CODEX_HOME so Desktop, stable CLI, and prerelease builds cannot mutate the same sessions or databases.",
  )
  process.exit(64)
}

fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
try {
  fs.chmodSync(codexHome, 0o700)
} catch {
  // Windows and some mounted filesystems do not implement POSIX mode changes.
}

const markerPath = path.join(codexHome, ".operator-codex-runtime.json")
const expected = {
  schema_version: 1,
  profile,
  binary,
  runtime_version: runtimeVersion,
}

let existing = null
if (fs.existsSync(markerPath)) {
  try {
    existing = JSON.parse(fs.readFileSync(markerPath, "utf8"))
  } catch (error) {
    console.error(`Refusing Codex state with an unreadable runtime marker: ${error.message}`)
    process.exit(65)
  }
  for (const key of ["schema_version", "profile", "binary", "runtime_version"]) {
    if (existing[key] !== expected[key]) {
      console.error(
        `Refusing to share CODEX_HOME across Codex runtimes: marker ${key}=${JSON.stringify(existing[key])}, requested ${key}=${JSON.stringify(expected[key])}. Create a new OPERATOR_CODEX_STATE_PROFILE instead.`,
      )
      process.exit(64)
    }
  }
} else {
  const entries = fs.readdirSync(codexHome).filter((entry) => entry !== path.basename(markerPath))
  const adopt = /^(1|true|yes)$/i.test(process.env.OPERATOR_ADOPT_CODEX_HOME || "")
  if (entries.length > 0 && !adopt) {
    console.error(
      `Refusing to adopt non-empty unmarked CODEX_HOME ${codexHome}. Snapshot it first, then set OPERATOR_ADOPT_CODEX_HOME=1 for one reviewed adoption or choose a new state profile.`,
    )
    process.exit(64)
  }
  atomicWriteJson(markerPath, {
    ...expected,
    created_at: new Date().toISOString(),
    adopted_existing_state: entries.length > 0,
  })
}

if (preflightOnly) {
  console.log(
    JSON.stringify(
      {
        safe: true,
        codex_home: codexHome,
        marker_path: markerPath,
        profile,
        binary,
        runtime_version: runtimeVersion,
        adopted_existing_state: existing?.adopted_existing_state ?? false,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const launcherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-cache-safe-launch.mjs")
const child = spawn(process.execPath, [launcherPath, ...argv], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    OPERATOR_CODEX_RUNTIME_ISOLATION_ACTIVE: "1",
    OPERATOR_CODEX_RUNTIME_VERSION: runtimeVersion,
    OPERATOR_CODEX_STATE_PROFILE: profile,
  },
  stdio: "inherit",
  shell: false,
  windowsHide: true,
})

child.on("error", (error) => {
  console.error(`Unable to start the guarded Codex launcher: ${error.message}`)
  process.exit(69)
})
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Guarded Codex launcher terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
