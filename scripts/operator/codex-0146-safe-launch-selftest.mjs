import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(scriptDir, "codex-0146-safe-launch.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-0146-boundary-"))
const home = path.join(root, "home")
const codexHome = path.join(root, "codex-home")
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(codexHome, { recursive: true })
fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "openai"\n')

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH || "",
    HOME: home,
    TMPDIR: root,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    OPERATOR_CODEX_BINARY: "codex",
    OPERATOR_PLATFORM_OVERRIDE: "linux",
    ...extra,
  }
}

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: path.resolve(scriptDir, "../.."),
    env: baseEnv(extraEnv),
    encoding: "utf8",
  })
}

const healthy = run(["--dry-run", "--", "exec", "--ephemeral", "-"])
if (healthy.status !== 0) {
  throw new Error(`healthy dry run failed: ${healthy.stderr}`)
}
const summary = JSON.parse(healthy.stdout)
const disabled = new Set()
for (let index = 0; index < summary.args.length - 1; index += 1) {
  if (summary.args[index] === "--disable") disabled.add(summary.args[index + 1])
}
for (const feature of [
  "remote_plugin",
  "code_mode",
  "code_mode_only",
  "multi_agent_v2",
  "token_budget",
  "external_agent_memory_import",
  "hooks",
  "code_mode_host",
  "standalone_web_search",
  "multi_agent",
  "mcp_2026_07_28",
  "tool_suggest",
  "executor_capability_discovery",
  "plugin_sharing",
  "skill_mcp_dependency_install",
]) {
  if (!disabled.has(feature)) throw new Error(`missing forced disable for ${feature}`)
}

const enableOverride = run(["--dry-run", "--", "--enable", "tool_suggest"])
if (enableOverride.status !== 64) {
  throw new Error(`tool_suggest override was not rejected: ${enableOverride.status}\n${enableOverride.stderr}`)
}

const configOverride = run(["--dry-run", "--", "-c", "features.hooks=true"])
if (configOverride.status !== 64) {
  throw new Error(`hooks config override was not rejected: ${configOverride.status}\n${configOverride.stderr}`)
}

const marketplaceDir = path.join(codexHome, "plugins")
fs.mkdirSync(marketplaceDir, { recursive: true })
fs.writeFileSync(
  path.join(marketplaceDir, "known_marketplaces.json"),
  JSON.stringify({ source: "anthropics/claude-code" }),
)
const prohibitedMarketplace = run(["--dry-run", "--", "exec", "-"])
if (prohibitedMarketplace.status !== 64) {
  throw new Error(
    `prohibited marketplace metadata was not rejected: ${prohibitedMarketplace.status}\n${prohibitedMarketplace.stderr}`,
  )
}
fs.rmSync(path.join(marketplaceDir, "known_marketplaces.json"))

const prohibitedEnvironment = run(["--dry-run", "--", "exec", "-"], {
  PLUGIN_MARKETPLACE_ROUTE: "amazon-bedrock-auto",
})
if (prohibitedEnvironment.status !== 64) {
  throw new Error(
    `prohibited environment route was not rejected: ${prohibitedEnvironment.status}\n${prohibitedEnvironment.stderr}`,
  )
}

console.log("Codex 0.146 release boundary self-test passed")
