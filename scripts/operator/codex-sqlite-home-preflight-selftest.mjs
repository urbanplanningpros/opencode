import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./codex-cache-safe-launch.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sqlite-home-"))
const codexHome = path.join(root, "codex-home")
const configHome = path.join(root, "config-sqlite")
const envHome = path.join(root, "env-sqlite")
const configPath = path.join(codexHome, "config.toml")
fs.mkdirSync(codexHome)
fs.mkdirSync(configHome)
fs.mkdirSync(envHome)

function run(extraEnv = {}, extraArgs = [], expected = 0) {
  const result = spawnSync(
    process.execPath,
    [script, "--dry-run", "--", "exec", "--ephemeral", "-", ...extraArgs],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CONFIG_PATH: configPath,
        OPERATOR_PLATFORM_OVERRIDE: "linux",
        ...extraEnv,
      },
    },
  )
  if (result.status !== expected) {
    throw new Error(`expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`)
  }
  return expected === 0 ? JSON.parse(result.stdout) : result.stderr
}

try {
  fs.writeFileSync(configPath, `sqlite_home = '${configHome.replaceAll("'", "")}'\n`)
  const configSelected = run({ CODEX_SQLITE_HOME: envHome })
  if (configSelected.sqlite_home !== path.resolve(configHome)) throw new Error("config sqlite_home was not selected")
  if (configSelected.sqlite_home_source !== "config.sqlite_home") throw new Error("config source was not recorded")

  fs.writeFileSync(configPath, "")
  const envSelected = run({ CODEX_SQLITE_HOME: envHome })
  if (envSelected.sqlite_home !== path.resolve(envHome)) throw new Error("CODEX_SQLITE_HOME was not selected")
  if (envSelected.sqlite_home_source !== "CODEX_SQLITE_HOME") throw new Error("env source was not recorded")

  const homeSelected = run({ CODEX_SQLITE_HOME: "" })
  if (homeSelected.sqlite_home !== path.resolve(codexHome)) throw new Error("CODEX_HOME fallback was not selected")
  if (homeSelected.sqlite_home_source !== "CODEX_HOME") throw new Error("fallback source was not recorded")

  fs.writeFileSync(configPath, "sqlite_home = './relative'\n")
  const relative = run({}, [], 64)
  if (!relative.includes("relative SQLite home")) throw new Error("relative sqlite_home was not rejected")

  fs.writeFileSync(configPath, "")
  const cliOverride = run({}, ["-c", `sqlite_home='${envHome}'`], 64)
  if (!cliOverride.includes("command-line sqlite_home override")) throw new Error("CLI override was not rejected")

  console.log("codex SQLite home preflight self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
