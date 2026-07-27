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

const preflightOnly = takeFlag("--approved-openai-preflight-only")
const separator = argv.indexOf("--")
const launcherArgs = separator === -1 ? [] : argv.slice(0, separator)
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)
const binary = process.env.OPERATOR_CODEX_BINARY || process.env.CODEX_BINARY || "codex"
const explicitVersion = (process.env.OPERATOR_CODEX_RUNTIME_VERSION || "").trim()
const approvedProvider = "openai"

function sanitize(value, label) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  if (!normalized) {
    console.error(`Unable to derive a safe ${label}.`)
    process.exit(64)
  }
  return normalized
}

function probeRuntimeVersion() {
  if (explicitVersion) return explicitVersion
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5000,
  })
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split(/\r?\n/).find(Boolean) || ""
  if (result.error || result.status !== 0 || !output) {
    const detail = result.error?.message || `exit ${result.status ?? "unknown"}`
    console.error(`Unable to identify the Codex runtime before provider/auth isolation (${detail}).`)
    process.exit(69)
  }
  return output
}

function selectedProvider(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if ((value === "-c" || value === "--config") && args[index + 1]) {
      const match = args[index + 1].match(/^model_provider\s*=\s*["']?([^"']+)["']?$/)
      if (match) return match[1]
    }
    const match = value.match(/^(?:-c|--config)=model_provider\s*=\s*["']?([^"']+)["']?$/)
    if (match) return match[1]
  }
  return null
}

function selectsProfile(args) {
  return args.some((value, index) => {
    if ((value === "-p" || value === "--profile") && args[index + 1]) return true
    if (/^--profile=/.test(value) || /^-p=/.test(value)) return true
    if ((value === "-c" || value === "--config") && /^profile\s*=/.test(args[index + 1] || "")) return true
    return /^(?:-c|--config)=profile\s*=/.test(value)
  })
}

if (selectsProfile(codexArgs)) {
  console.error(
    "Refusing a Codex config profile on the approved direct-OpenAI route because a profile can change provider, model, plugin catalog, or feature policy.",
  )
  process.exit(64)
}
if (codexArgs.some((value) => value === "--local-provider" || value.startsWith("--local-provider="))) {
  console.error("Refusing --local-provider on the approved direct-OpenAI route. Use the separately authorized local launcher.")
  process.exit(64)
}

const requestedProvider = selectedProvider(codexArgs) || process.env.OPERATOR_MODEL_PROVIDER || null
if (requestedProvider && requestedProvider !== approvedProvider) {
  console.error(
    `Refusing model provider '${requestedProvider}'. This launcher is pinned to '${approvedProvider}' and cannot route through gateways, Bedrock, Vertex, or other providers.`,
  )
  process.exit(64)
}

const runtimeVersion = probeRuntimeVersion()
const runtimeProfile = sanitize(runtimeVersion, "runtime profile")
const inferredAuthProfile = process.env.OPENAI_API_KEY ? "openai-api-primary" : "openai-chatgpt-primary"
const authProfile = sanitize(process.env.OPERATOR_CODEX_AUTH_PROFILE || inferredAuthProfile, "OpenAI auth profile")
const stateProfile = process.env.OPERATOR_CODEX_STATE_PROFILE || `${runtimeProfile}--${authProfile}`
if (!/^[A-Za-z0-9._-]{1,192}$/.test(stateProfile)) {
  console.error(
    "OPERATOR_CODEX_STATE_PROFILE must contain only letters, numbers, dots, underscores, or hyphens and be at most 192 characters.",
  )
  process.exit(64)
}

const home = os.homedir()
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(home, ".codex-operator", stateProfile))
if (codexHome === path.resolve(path.join(home, ".codex"))) {
  console.error("Refusing shared ~/.codex state. Use the runtime- and auth-specific state directory selected by this launcher.")
  process.exit(64)
}

const configPath = path.resolve(process.env.CODEX_CONFIG_PATH || path.join(codexHome, "config.toml"))
let configText = ""
try {
  configText = fs.readFileSync(configPath, "utf8")
} catch {
  configText = ""
}
const topLevelConfig = configText.split(/^\s*\[/m, 1)[0]
const configuredProvider = topLevelConfig.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*$/m)?.[1] || null
if (configuredProvider && configuredProvider !== approvedProvider) {
  console.error(
    `Refusing top-level model_provider '${configuredProvider}' in ${configPath}. This route requires model_provider='${approvedProvider}'.`,
  )
  process.exit(64)
}
if (/^\s*profile\s*=/m.test(topLevelConfig)) {
  console.error(`Refusing a top-level profile in ${configPath}; use explicit reviewed flags on the approved route.`)
  process.exit(64)
}

const runtimeLauncher = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-runtime-isolation-launch.mjs")
const forwardedArgs = [
  ...launcherArgs,
  "--",
  "-c",
  `model_provider="${approvedProvider}"`,
  ...codexArgs,
]
const summary = {
  safe: true,
  provider: approvedProvider,
  runtime_version: runtimeVersion,
  auth_profile: authProfile,
  state_profile: stateProfile,
  codex_home: codexHome,
  config_path: configPath,
  runtime_launcher: runtimeLauncher,
  forwarded_args: forwardedArgs,
  config_profiles_allowed: false,
  provider_fallback_allowed: false,
}

if (preflightOnly) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.error(
  `Approved Codex route active: provider ${approvedProvider}; auth profile ${authProfile}; isolated state ${stateProfile}; provider fallback and config profiles are blocked.`,
)
const child = spawn(process.execPath, [runtimeLauncher, ...forwardedArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    OPERATOR_CODEX_RUNTIME_VERSION: runtimeVersion,
    OPERATOR_CODEX_STATE_PROFILE: stateProfile,
    OPERATOR_CODEX_AUTH_PROFILE: authProfile,
    OPERATOR_MODEL_PROVIDER: approvedProvider,
    CODEX_APPROVED_OPENAI_ROUTE_ACTIVE: "1",
  },
  stdio: "inherit",
  shell: false,
  windowsHide: true,
})

child.on("error", (error) => {
  console.error(`Unable to start the approved Codex route: ${error.message}`)
  process.exit(69)
})

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Approved Codex route terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
