import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

if (!process.versions.bun) {
  console.error("Run this guard with Bun so the delegated operator launcher retains bun:sqlite support.")
  process.exit(69)
}

const argv = process.argv.slice(2)
const dryRunIndex = argv.indexOf("--dry-run")
const dryRun = dryRunIndex !== -1
if (dryRun) argv.splice(dryRunIndex, 1)

const separator = argv.indexOf("--")
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)
const joined = codexArgs.join(" ")

const enablesHooks =
  /(?:^|\s)--enable(?:=|\s+)hooks(?:\s|$)/i.test(joined) ||
  /(?:^|\s)(?:-c|--config)(?:=|\s+)features\.hooks\s*=\s*true(?:\s|$)/i.test(joined)

if (enablesHooks) {
  console.error(
    "Refusing to enable Codex hooks while root/plugin UserPromptSubmit ordering and deny short-circuit behavior are not authoritative.",
  )
  process.exit(64)
}

const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const configPath = path.resolve(process.env.CODEX_CONFIG_PATH || path.join(codexHome, "config.toml"))
let configText = ""
try {
  configText = fs.readFileSync(configPath, "utf8")
} catch {}

function featureEnabled(config, feature) {
  let section = ""
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim()
    if (!line) continue
    const sectionMatch = line.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      continue
    }
    if (section !== "features") continue
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*$/i)
    if (assignment && assignment[1] === feature) return assignment[2].toLowerCase() === "true"
  }
  return false
}

if (featureEnabled(configText, "hooks")) {
  console.error(
    `Refusing Codex because hooks are enabled in ${configPath}. Set [features].hooks=false or use a dedicated guarded CODEX_HOME.`,
  )
  process.exit(64)
}

const delegatedLauncher = path.resolve("scripts/operator/codex-cache-safe-launch.mjs")
if (!fs.existsSync(delegatedLauncher)) {
  console.error(`Missing delegated operator launcher: ${delegatedLauncher}`)
  process.exit(69)
}

const delegatedArgs = [
  delegatedLauncher,
  ...(dryRun ? ["--dry-run"] : []),
  "--",
  "--disable",
  "hooks",
  ...codexArgs,
]

if (!dryRun) {
  console.error(
    "Codex hook policy guard active: lifecycle hooks are disabled; root and plugin hooks cannot receive or persist prompt content.",
  )
}

const child = spawn(process.execPath, delegatedArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_HOOK_POLICY_GUARD_ACTIVE: "1",
  },
  stdio: "inherit",
  shell: false,
})

child.on("error", (error) => {
  console.error(`Unable to start the delegated guarded Codex launcher: ${error.message}`)
  process.exit(69)
})

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Delegated guarded Codex launcher terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
