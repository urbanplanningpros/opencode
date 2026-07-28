import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nowIso, parseArgs } from "./lib.mjs"

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const args = parseArgs(process.argv.slice(2))

function numeric(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Refusing invalid ${label}; expected a non-negative byte count.`)
    process.exit(2)
  }
  return parsed
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
    if (!parsed) {
      console.error("Refusing malformed sqlite_home in config.toml; use one non-empty quoted absolute path.")
      process.exit(64)
    }
    return parsed
  }
  return null
}

function resolveAbsolute(value, source) {
  let expanded = value
  if (expanded === "~") expanded = os.homedir()
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = path.join(os.homedir(), expanded.slice(2))
  if (!path.isAbsolute(expanded)) {
    console.error(`Refusing relative SQLite home from ${source}; configure an absolute path.`)
    process.exit(64)
  }
  return path.resolve(expanded)
}

const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const configPath = path.resolve(args["config-path"] || process.env.CODEX_CONFIG_PATH || path.join(codexHome, "config.toml"))
const configText = (() => {
  try {
    return fs.readFileSync(configPath, "utf8")
  } catch {
    return ""
  }
})()
const configuredHome = configuredSqliteHome(configText)
const sqliteHome = args["sqlite-home"]
  ? resolveAbsolute(args["sqlite-home"], "--sqlite-home")
  : configuredHome
    ? resolveAbsolute(configuredHome, "config.toml sqlite_home")
    : process.env.CODEX_SQLITE_HOME
      ? resolveAbsolute(process.env.CODEX_SQLITE_HOME, "CODEX_SQLITE_HOME")
      : codexHome
const sqliteHomeSource = args["sqlite-home"]
  ? "argument"
  : configuredHome
    ? "config.sqlite_home"
    : process.env.CODEX_SQLITE_HOME
      ? "CODEX_SQLITE_HOME"
      : "CODEX_HOME"

const limits = {
  dbWarnBytes: numeric(args["db-warn-bytes"] || process.env.OPERATOR_CODEX_LOG_DB_WARN_BYTES, 256 * MiB, "DB warning threshold"),
  dbCriticalBytes: numeric(
    args["db-critical-bytes"] || process.env.OPERATOR_CODEX_LOG_DB_CRITICAL_BYTES,
    768 * MiB,
    "DB critical threshold",
  ),
  walWarnBytes: numeric(args["wal-warn-bytes"] || process.env.OPERATOR_CODEX_LOG_WAL_WARN_BYTES, 256 * MiB, "WAL warning threshold"),
  walCriticalBytes: numeric(
    args["wal-critical-bytes"] || process.env.OPERATOR_CODEX_LOG_WAL_CRITICAL_BYTES,
    1 * GiB,
    "WAL critical threshold",
  ),
  totalWarnBytes: numeric(
    args["total-warn-bytes"] || process.env.OPERATOR_CODEX_LOG_TOTAL_WARN_BYTES,
    512 * MiB,
    "total warning threshold",
  ),
  totalCriticalBytes: numeric(
    args["total-critical-bytes"] || process.env.OPERATOR_CODEX_LOG_TOTAL_CRITICAL_BYTES,
    1536 * MiB,
    "total critical threshold",
  ),
  freeWarnBytes: numeric(args["free-warn-bytes"] || process.env.OPERATOR_CODEX_LOG_FREE_WARN_BYTES, 10 * GiB, "free-space warning threshold"),
  freeCriticalBytes: numeric(
    args["free-critical-bytes"] || process.env.OPERATOR_CODEX_LOG_FREE_CRITICAL_BYTES,
    5 * GiB,
    "free-space critical threshold",
  ),
}

for (const [warn, critical] of [
  [limits.dbWarnBytes, limits.dbCriticalBytes],
  [limits.walWarnBytes, limits.walCriticalBytes],
  [limits.totalWarnBytes, limits.totalCriticalBytes],
]) {
  if (critical < warn) {
    console.error("Refusing thresholds where a critical byte limit is below its warning limit.")
    process.exit(2)
  }
}

function inspectFile(file) {
  try {
    const lstat = fs.lstatSync(file)
    return {
      path: file,
      exists: true,
      bytes: lstat.size,
      modified_at: lstat.mtime.toISOString(),
      is_file: lstat.isFile(),
      is_symlink: lstat.isSymbolicLink(),
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: file, exists: false, bytes: 0, modified_at: null, is_file: false, is_symlink: false }
    }
    throw error
  }
}

function disk(root) {
  try {
    const target = fs.existsSync(root) ? root : path.dirname(root)
    const stat = fs.statfsSync(target)
    return {
      total_bytes: Number(stat.blocks) * Number(stat.bsize),
      free_bytes: Number(stat.bavail) * Number(stat.bsize),
    }
  } catch {
    return { total_bytes: null, free_bytes: null }
  }
}

const files = {
  database: inspectFile(path.join(sqliteHome, "logs_2.sqlite")),
  wal: inspectFile(path.join(sqliteHome, "logs_2.sqlite-wal")),
  shm: inspectFile(path.join(sqliteHome, "logs_2.sqlite-shm")),
}
const totalBytes = files.database.bytes + files.wal.bytes + files.shm.bytes
const filesystem = disk(sqliteHome)
const criticalReasons = []
const warningReasons = []

for (const [name, file] of Object.entries(files)) {
  if (file.exists && (!file.is_file || file.is_symlink)) criticalReasons.push(`${name}_path_not_regular_file`)
}
if (files.database.bytes >= limits.dbCriticalBytes) criticalReasons.push("logs_db_size_critical")
else if (files.database.bytes >= limits.dbWarnBytes) warningReasons.push("logs_db_size_warning")
if (files.wal.bytes >= limits.walCriticalBytes) criticalReasons.push("logs_wal_size_critical")
else if (files.wal.bytes >= limits.walWarnBytes) warningReasons.push("logs_wal_size_warning")
if (totalBytes >= limits.totalCriticalBytes) criticalReasons.push("logs_storage_total_critical")
else if (totalBytes >= limits.totalWarnBytes) warningReasons.push("logs_storage_total_warning")
if (filesystem.free_bytes !== null && filesystem.free_bytes <= limits.freeCriticalBytes) criticalReasons.push("disk_free_critical")
else if (filesystem.free_bytes !== null && filesystem.free_bytes <= limits.freeWarnBytes) warningReasons.push("disk_free_warning")

const status = criticalReasons.length > 0 ? "critical" : warningReasons.length > 0 ? "warning" : "safe"
const result = {
  status,
  checked_at: nowIso(),
  codex_home: codexHome,
  config_path: configPath,
  sqlite_home: sqliteHome,
  sqlite_home_source: sqliteHomeSource,
  files,
  total_log_storage_bytes: totalBytes,
  disk: filesystem,
  critical_reasons: criticalReasons,
  warning_reasons: warningReasons,
  safe_to_launch_desktop: status !== "critical",
  safe_to_mutate_logs_database_while_codex_is_running: false,
  upstream_issue: "openai/codex#35823",
  remediation: [
    "Checkpoint active task manifests, repository state, operation IDs, and idempotency keys.",
    "Stop Codex Desktop, CLI, app-server, VS Code extension, and any other process using this SQLite profile before maintenance.",
    "Back up logs_2.sqlite together with its -wal and -shm companions; never apply this maintenance to state_5.sqlite.",
    "Run integrity_check before and after a reviewed offline checkpoint plus incremental_vacuum operation.",
    "When the current profile is critical, keep unrelated work operating through a fresh isolated approved CODEX_HOME or explicitly authorized local route.",
    "Reconcile every unverified external write before replaying work after a state or storage failure.",
  ],
  offline_maintenance_sql: [
    "PRAGMA integrity_check;",
    "PRAGMA wal_checkpoint(TRUNCATE);",
    "PRAGMA incremental_vacuum;",
    "PRAGMA integrity_check;",
  ],
  limits,
}

console.log(JSON.stringify(result, null, 2))
if (status === "critical" || (status === "warning" && args["fail-on-warning"])) process.exit(75)
