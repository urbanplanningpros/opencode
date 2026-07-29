import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
const separator = argv.indexOf("--")
if (separator === -1) {
  console.error("Usage: node scripts/operator/codex-0146-safe-launch.mjs [launcher options] -- <codex args>")
  process.exit(2)
}

const launcherOptions = argv.slice(0, separator)
const codexArgs = argv.slice(separator + 1)
const joined = codexArgs.join(" ")

const releaseBoundaryFeatures = [
  { feature: "hooks", reason: "external lifecycle-hook intake boundary" },
  { feature: "code_mode_host", reason: "remote Code Mode host boundary" },
  { feature: "standalone_web_search", reason: "custom-provider web-search boundary" },
  { feature: "multi_agent", reason: "single-agent operator boundary" },
  { feature: "mcp_2026_07_28", reason: "MCP 2026 canary boundary" },
  { feature: "tool_suggest", reason: "model-initiated plugin installation boundary" },
  { feature: "executor_capability_discovery", reason: "executor capability admission boundary" },
  { feature: "plugin_sharing", reason: "plugin publishing and sharing boundary" },
  { feature: "skill_mcp_dependency_install", reason: "model-initiated dependency installation boundary" },
]

for (const item of releaseBoundaryFeatures) {
  const enableFlag = new RegExp(`--enable(?:=|\\s+)${item.feature}(?:\\s|$)`, "i")
  const configFlag = new RegExp(`(?:-c|--config)(?:=|\\s+)features\\.${item.feature}\\s*=\\s*true`, "i")
  if (enableFlag.test(joined) || configFlag.test(joined)) {
    console.error(`Refusing to enable ${item.feature} while the Codex 0.146 release boundary is active: ${item.reason}.`)
    process.exit(64)
  }
}

const prohibitedRoutePattern = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|model[ _-]?gateway)/i
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const inspectedFiles = [
  path.join(codexHome, "config.toml"),
  path.join(codexHome, "settings.json"),
  path.join(codexHome, "plugins", "known_marketplaces.json"),
]

for (const file of inspectedFiles) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error.code === "ENOENT") continue
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    console.error(`Refusing unsafe Codex release-boundary configuration path: ${file}`)
    process.exit(64)
  }
  const contents = fs.readFileSync(file, "utf8")
  if (prohibitedRoutePattern.test(contents)) {
    console.error(`Refusing Codex 0.146 admission because prohibited provider or gateway metadata exists in ${file}.`)
    process.exit(64)
  }
}

for (const [name, value] of Object.entries(process.env)) {
  if (!/^(CODEX|OPERATOR|MCP|PLUGIN|AGENT)_/i.test(name)) continue
  if (prohibitedRoutePattern.test(`${name}=${value || ""}`)) {
    console.error(`Refusing Codex 0.146 admission because environment variable ${name} contains a prohibited route identifier.`)
    process.exit(64)
  }
}

const forcedDisableArgs = releaseBoundaryFeatures.flatMap((item) => ["--disable", item.feature])
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const guardedLauncher = path.join(scriptDir, "codex-cache-safe-launch.mjs")
const child = spawn(
  process.execPath,
  [guardedLauncher, ...launcherOptions, "--", ...forcedDisableArgs, ...codexArgs],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_0146_RELEASE_BOUNDARY_ACTIVE: "1",
      CODEX_HOOK_INTAKE_GUARD_ACTIVE: "1",
      CODEX_PLUGIN_MARKETPLACE_GUARD_ACTIVE: "1",
      CODEX_MODEL_INSTALL_GUARD_ACTIVE: "1",
    },
    stdio: "inherit",
  },
)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on("error", (error) => {
  console.error(`Unable to start guarded Codex launcher: ${error.message}`)
  process.exit(69)
})

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
