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
  {
    feature: "external_agent_memory_import",
    reason: "excluded-provider session and memory intake guard",
  },
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

if (/(?:^|\s)(?:-c|--config)(?:=|\s+)sqlite_home\s*=/i.test(joined)) {
  console.error(
    "Refusing a command-line sqlite_home override because the preflight must resolve the same state database as Codex. Set sqlite_home in config.toml or CODEX_SQLITE_HOME instead.",
  )
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
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const configPath = path.resolve(process.env.CODEX_CONFIG_PATH || path.join(codexHome, "config.toml"))
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

function stripTomlComment(value) {
  let quote = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "#") return value.slice(0, index).trim()
  }
  return value.trim()
}

function parseTomlString(value) {
  const raw = stripTomlComment(value)
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  return null
}

function configuredSqliteHome(config) {
  let topLevel = true
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (/^\[/.test(trimmed)) topLevel = false
    if (!topLevel) continue
    const match = line.match(/^\s*sqlite_home\s*=\s*(.+)$/)
    if (!match) continue
    const parsed = parseTomlString(match[1])
    if (parsed === null || parsed.length === 0) {
      console.error("Refusing malformed sqlite_home in config.toml; use one non-empty quoted absolute path.")
      process.exit(64)
    }
    return parsed
  }
  return null
}

function resolveSqliteHome(value, source) {
  let expanded = value
  if (expanded === "~") expanded = os.homedir()
  if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2))
  }
  if (!path.isAbsolute(expanded)) {
    console.error(`Refusing relative SQLite home from ${source}; configure an absolute path.`)
    process.exit(64)
  }
  return path.resolve(expanded)
}

const configSqliteHome = configuredSqliteHome(configText)
const sqliteHomeSource = configSqliteHome
  ? "config.sqlite_home"
  : process.env.CODEX_SQLITE_HOME
    ? "CODEX_SQLITE_HOME"
    : "CODEX_HOME"
const sqliteHome = resolveSqliteHome(configSqliteHome || process.env.CODEX_SQLITE_HOME || codexHome, sqliteHomeSource)
const logDbPath = path.join(sqliteHome, "logs_2.sqlite")
const sqliteLockGuardDisabled = /^(1|true|yes)$/i.test(process.env.OPERATOR_CODEX_SKIP_SQLITE_LOCK_GUARD || "")
let sqliteLockStatus = fs.existsSync(logDbPath) ? "unchecked" : "not_present"

async function verifyLogDatabaseWriteAvailability() {
  if (sqliteLockGuardDisabled || !fs.existsSync(logDbPath)) {
    sqliteLockStatus = sqliteLockGuardDisabled ? "disabled_by_operator" : "not_present"
    return
  }

  let Database
  try {
    ;({ Database } = await import("bun:sqlite"))
  } catch (error) {
    console.error(`Unable to load bun:sqlite for the Codex telemetry-lock preflight: ${error.message}`)
    process.exit(69)
  }

  const attempts = Number.parseInt(process.env.OPERATOR_CODEX_SQLITE_LOCK_ATTEMPTS || "3", 10)
  const boundedAttempts = Number.isFinite(attempts) ? Math.min(Math.max(attempts, 1), 10) : 3
  let lastError = null

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    let database
    try {
      database = new Database(logDbPath)
      database.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE; ROLLBACK;")
      sqliteLockStatus = "available"
      return
    } catch (error) {
      lastError = error
      const message = String(error?.message || error)
      const locked = /database is locked|SQLITE_BUSY/i.test(message)
      if (!locked) {
        console.error(`Codex telemetry database preflight failed for ${logDbPath}: ${message}`)
        process.exit(69)
      }
      if (attempt < boundedAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2000)))
      }
    } finally {
      try {
        database?.close()
      } catch {}
    }
  }

  sqliteLockStatus = "blocked"
  console.error(
    `Refusing to start Codex because ${logDbPath} remained write-locked after ${boundedAttempts} bounded attempts. Do not delete SQLite files. Identify the stale or suspended holder, checkpoint active work, terminate only the confirmed stale holder, then rerun the guarded launcher. Continue unrelated work through a separately provisioned approved state profile or the authorized local route. Last error: ${String(lastError?.message || lastError)}`,
  )
  process.exit(75)
}

if (!dryRun) await verifyLogDatabaseWriteAvailability()

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
  "--disable",
  "external_agent_memory_import",
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
  sqlite_home: sqliteHome,
  sqlite_home_source: sqliteHomeSource,
  sqlite_log_database: logDbPath,
  model: requestedModel || quotaSafeModel,
  quota_safe_model: quotaSafeModel,
  remote_plugin: false,
  code_mode: false,
  code_mode_only: false,
  multi_agent_v2: false,
  token_budget: false,
  external_agent_memory_import: false,
  agents_enabled: false,
  max_concurrent_threads_per_session: 1,
  http_sse_recovery: forceHttpSse,
  openai_websockets: forceHttpSse ? false : "configured_default",
  macos_permissions_profile_guard: isMac,
  macos_permissions_profile_active: false,
  sqlite_lock_guard: !sqliteLockGuardDisabled,
  sqlite_lock_status: sqliteLockStatus,
}

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.error(
  `Codex guards active: model ${summary.model}; remote_plugin, code_mode, code_mode_only, multi_agent_v2, token_budget, and external_agent_memory_import are disabled; subagents are disabled and thread fan-out is capped at one; SQLite lock preflight targets ${summary.sqlite_home_source}${
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
    CODEX_EXTERNAL_AGENT_IMPORT_GUARD_ACTIVE: "1",
    CODEX_SQLITE_LOCK_GUARD_ACTIVE: sqliteLockGuardDisabled ? "0" : "1",
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
