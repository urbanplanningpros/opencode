import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const argv = process.argv.slice(2)
const takeFlag = (name) => {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}
const dryRun = takeFlag("--dry-run")
const forceHttpSse =
  takeFlag("--http-sse-recovery") || /^(1|true|yes)$/i.test(process.env.OPERATOR_CODEX_FORCE_HTTP_SSE || "")
const separator = argv.indexOf("--")
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)
const joined = codexArgs.join(" ")
const quotaSafeModel = process.env.OPERATOR_CODEX_QUOTA_SAFE_MODEL || "gpt-5.6-luna"

const prohibitedFeatureOverrides = [
  { feature: "remote_plugin", reason: "Codex cache write-amplification guard" },
  { feature: "code_mode", reason: "Code Mode metadata-header guard" },
  { feature: "code_mode_only", reason: "Code Mode metadata-header guard" },
  { feature: "multi_agent_v2", reason: "Codex recursive-subagent quota guard" },
  { feature: "token_budget", reason: "model-owned token-budget and compaction-policy guard" },
]

for (const item of prohibitedFeatureOverrides) {
  const enableFlag = new RegExp(`--enable(?:=|\\s+)${item.feature}(?:\\s|$)`, "i")
  const configFlag = new RegExp(`(?:-c|--config)(?:=|\\s+)features\\.${item.feature}\\s*=\\s*true`, "i")
  if (enableFlag.test(joined) || configFlag.test(joined)) {
    console.error(`Refusing to enable ${item.feature} while the ${item.reason} is active.`)
    process.exit(64)
  }
}

if (
  forceHttpSse &&
  /(?:-c|--config)(?:=|\s+)model_providers\.openai\.supports_websockets\s*=\s*true/i.test(joined)
) {
  console.error("Refusing to re-enable OpenAI WebSockets while attestation/compaction HTTP-SSE recovery is active.")
  process.exit(64)
}

function selectedModel(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if ((value === "-m" || value === "--model") && args[index + 1]) return args[index + 1]
    if (value.startsWith("--model=")) return value.slice("--model=".length)
    if (value.startsWith("-m=") && value.length > 3) return value.slice(3)
    if ((value === "-c" || value === "--config") && args[index + 1]) {
      const match = args[index + 1].match(/^model\s*=\s*["']?([^"']+)["']?$/)
      if (match) return match[1]
    }
    const configMatch = value.match(/^(?:-c|--config)=model\s*=\s*["']?([^"']+)["']?$/)
    if (configMatch) return configMatch[1]
  }
  return null
}

const requestedModel = selectedModel(codexArgs) || process.env.OPERATOR_MODEL || null
if (requestedModel && requestedModel !== quotaSafeModel) {
  console.error(
    `Refusing Codex model '${requestedModel}' while recursive-subagent quota containment is active. Approved model: ${quotaSafeModel}.`,
  )
  process.exit(64)
}
if (/model_reasoning_effort\s*=\s*["']?ultra/i.test(joined)) {
  console.error("Refusing Ultra reasoning while it can activate automatic task delegation.")
  process.exit(64)
}

const platform = process.env.OPERATOR_PLATFORM_OVERRIDE || process.platform
const isMac = platform === "darwin"
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
const configPath = process.env.CODEX_CONFIG_PATH || path.join(codexHome, "config.toml")
const configText = (() => {
  try {
    return fs.readFileSync(configPath, "utf8")
  } catch {
    return ""
  }
})()
const profileFlag = codexArgs.some(
  (arg, index) =>
    arg === "-P" ||
    arg === "--permissions-profile" ||
    /^-P.+/.test(arg) ||
    /^--permissions-profile=/.test(arg) ||
    ((arg === "-c" || arg === "--config") && /default_permissions\s*=/.test(codexArgs[index + 1] || "")),
)
const configActivatesProfile = /^\s*default_permissions\s*=/m.test(configText)
if (isMac && (profileFlag || configActivatesProfile)) {
  console.error(
    "Refusing to activate a Codex permissions profile on macOS while affected stable builds can abort before sandboxed exec. Remove -P/default_permissions and keep git mutations in approved GitHub or CI workflows.",
  )
  process.exit(64)
}

const binary = process.env.OPERATOR_CODEX_BINARY || process.env.CODEX_BINARY || "codex"
const modelArgs = requestedModel ? [] : ["-m", quotaSafeModel]
const guardedArgs = [
  "--disable",
  "remote_plugin",
  "--disable",
  "code_mode",
  "--disable",
  "code_mode_only",
  "--disable",
  "multi_agent_v2",
  "--disable",
  "token_budget",
  "-c",
  "agents.enabled=false",
  "-c",
  "agents.max_concurrent_threads_per_session=1",
  ...modelArgs,
  ...(forceHttpSse ? ["-c", "model_providers.openai.supports_websockets=false"] : []),
  ...codexArgs,
]
const summary = {
  binary,
  args: guardedArgs,
  codex_home: codexHome,
  config_path: configPath,
  model: requestedModel || quotaSafeModel,
  quota_safe_model: quotaSafeModel,
  remote_plugin: false,
  code_mode: false,
  code_mode_only: false,
  multi_agent_v2: false,
  token_budget: false,
  agents_enabled: false,
  max_concurrent_threads_per_session: 1,
  http_sse_recovery: forceHttpSse,
  openai_websockets: forceHttpSse ? false : "configured_default",
  macos_permissions_profile_guard: isMac,
  macos_permissions_profile_active: false,
}

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.error(
  `Codex guards active: model ${summary.model}; remote_plugin, code_mode, code_mode_only, multi_agent_v2, and token_budget are disabled; subagents are disabled and thread fan-out is capped at one${
    forceHttpSse ? "; OpenAI Responses transport is forced to HTTP-SSE for attestation/compaction recovery" : ""
  }${isMac ? "; macOS permissions profiles are blocked" : ""}. Local and installed tooling remain available.`,
)
const child = spawn(binary, guardedArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_CACHE_GUARD_ACTIVE: "1",
    CODEX_CODE_MODE_GUARD_ACTIVE: "1",
    CODEX_SUBAGENT_QUOTA_GUARD_ACTIVE: "1",
    CODEX_TOKEN_BUDGET_GUARD_ACTIVE: "1",
    OPERATOR_MODEL: summary.model,
    ...(forceHttpSse && { CODEX_HTTP_SSE_RECOVERY_ACTIVE: "1" }),
    ...(isMac && { CODEX_MACOS_PERMISSIONS_PROFILE_GUARD_ACTIVE: "1" }),
  },
  stdio: "inherit",
  shell: false,
})

child.on("error", (error) => {
  console.error(`Unable to start guarded Codex CLI: ${error.message}`)
  process.exit(69)
})

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Guarded Codex CLI terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
