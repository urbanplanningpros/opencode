import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nowIso, parseArgs } from "./lib.mjs"

const GiB = 1024 ** 3
const MiB = 1024 ** 2
const args = parseArgs(process.argv.slice(2))
const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const sessionsRoot = path.join(codexHome, "sessions")
const configPath = path.resolve(args["config-path"] || process.env.CODEX_CONFIG_PATH || path.join(codexHome, "config.toml"))
const durationMs = Number(args["duration-ms"] || 0)
const intervalMs = Math.max(25, Number(args["interval-ms"] || 500))
const limits = {
  totalWarnBytes: Number(args["total-warn-bytes"] || process.env.OPERATOR_CODEX_SESSION_TOTAL_WARN_BYTES || 20 * GiB),
  totalCriticalBytes: Number(
    args["total-critical-bytes"] || process.env.OPERATOR_CODEX_SESSION_TOTAL_CRITICAL_BYTES || 50 * GiB,
  ),
  fileWarnBytes: Number(args["file-warn-bytes"] || process.env.OPERATOR_CODEX_SESSION_FILE_WARN_BYTES || 512 * MiB),
  fileCriticalBytes: Number(
    args["file-critical-bytes"] || process.env.OPERATOR_CODEX_SESSION_FILE_CRITICAL_BYTES || 2 * GiB,
  ),
  freeWarnBytes: Number(args["free-warn-bytes"] || process.env.OPERATOR_CODEX_SESSION_FREE_WARN_BYTES || 20 * GiB),
  freeCriticalBytes: Number(
    args["free-critical-bytes"] || process.env.OPERATOR_CODEX_SESSION_FREE_CRITICAL_BYTES || 10 * GiB,
  ),
  growthWarnBytesPerHour: Number(
    args["growth-warn-bytes-per-hour"] || process.env.OPERATOR_CODEX_SESSION_GROWTH_WARN_BYTES_PER_HOUR || 1 * GiB,
  ),
  growthCriticalBytesPerHour: Number(
    args["growth-critical-bytes-per-hour"] ||
      process.env.OPERATOR_CODEX_SESSION_GROWTH_CRITICAL_BYTES_PER_HOUR ||
      5 * GiB,
  ),
}

function walk(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = fs.statSync(full)
      files.push({ path: full, bytes: stat.size, mtime_ms: stat.mtimeMs })
    }
  }
  return files
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

function snapshot() {
  const files = walk(sessionsRoot).sort((a, b) => b.bytes - a.bytes)
  return {
    at: nowIso(),
    files,
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largest_file_bytes: files[0]?.bytes || 0,
    large_files: files.filter((file) => file.bytes >= limits.fileWarnBytes).slice(0, 20),
    disk: disk(codexHome),
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function setForkLimit() {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : ""
  const lines = original.split(/\r?\n/)
  const sectionIndex = lines.findIndex((line) => /^\s*\[agents\]\s*$/.test(line))
  if (sectionIndex === -1) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("")
    lines.push("[agents]", "max_concurrent_threads_per_session = 1", "")
  } else {
    let nextSection = lines.length
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
        nextSection = index
        break
      }
    }
    const keyIndex = lines.findIndex(
      (line, index) =>
        index > sectionIndex && index < nextSection && /^\s*max_concurrent_threads_per_session\s*=/.test(line),
    )
    if (keyIndex === -1) lines.splice(sectionIndex + 1, 0, "max_concurrent_threads_per_session = 1")
    else lines[keyIndex] = "max_concurrent_threads_per_session = 1"
  }

  const rendered = lines.join("\n").replace(/\n{3,}/g, "\n\n")
  const stamp = nowIso().replace(/[:.]/g, "-")
  const backupDir = path.join(codexHome, "operator-backups", "session-storage", stamp)
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const backupPath = path.join(backupDir, "config.toml")
  fs.writeFileSync(backupPath, original, { mode: 0o600 })
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const temp = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.tmp`)
  fs.writeFileSync(temp, rendered, { mode: 0o600 })
  fs.renameSync(temp, configPath)
  return { applied: true, backup_path: backupPath, config_path: configPath }
}

const first = snapshot()
let last = first
if (durationMs > 0) {
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    await sleep(Math.min(intervalMs, Math.max(1, end - Date.now())))
    last = snapshot()
  }
}

const elapsedHours = durationMs > 0 ? durationMs / 3_600_000 : 0
const growthBytes = Math.max(0, last.total_bytes - first.total_bytes)
const growthBytesPerHour = elapsedHours > 0 ? growthBytes / elapsedHours : 0
const criticalReasons = []
const warningReasons = []

if (last.total_bytes >= limits.totalCriticalBytes) criticalReasons.push("session_store_total_critical")
else if (last.total_bytes >= limits.totalWarnBytes) warningReasons.push("session_store_total_warning")
if (last.largest_file_bytes >= limits.fileCriticalBytes) criticalReasons.push("session_file_size_critical")
else if (last.largest_file_bytes >= limits.fileWarnBytes) warningReasons.push("session_file_size_warning")
if (last.disk.free_bytes !== null && last.disk.free_bytes <= limits.freeCriticalBytes) criticalReasons.push("disk_free_critical")
else if (last.disk.free_bytes !== null && last.disk.free_bytes <= limits.freeWarnBytes) warningReasons.push("disk_free_warning")
if (growthBytesPerHour >= limits.growthCriticalBytesPerHour) criticalReasons.push("session_growth_rate_critical")
else if (growthBytesPerHour >= limits.growthWarnBytesPerHour) warningReasons.push("session_growth_rate_warning")

const status = criticalReasons.length > 0 ? "critical" : warningReasons.length > 0 ? "warning" : "safe"
const configChange = args["apply-fork-limit"] ? setForkLimit() : { applied: false }
const result = {
  status,
  codex_home: codexHome,
  sessions_root: sessionsRoot,
  session_file_count: last.file_count,
  session_total_bytes: last.total_bytes,
  largest_session_file_bytes: last.largest_file_bytes,
  disk_total_bytes: last.disk.total_bytes,
  disk_free_bytes: last.disk.free_bytes,
  growth_observation_ms: durationMs,
  observed_growth_bytes: growthBytes,
  projected_growth_bytes_per_hour: growthBytesPerHour,
  large_session_files: last.large_files.map((file) => ({
    path: path.relative(codexHome, file.path),
    bytes: file.bytes,
    mtime_ms: file.mtime_ms,
  })),
  critical_reasons: criticalReasons,
  warning_reasons: warningReasons,
  safe_to_resume_existing_screenshot_heavy_thread: status === "safe",
  safe_to_fork_full_parent_context: status === "safe" && last.largest_file_bytes < limits.fileWarnBytes,
  config_change: configChange,
  remediation: [
    "Checkpoint objective, acceptance criteria, decisions, changed files, pending writes, and continuation prompt outside Codex session history.",
    "Move screenshot-heavy browser work into a fresh short-lived thread per phase instead of repeatedly resuming one image-heavy thread.",
    "Pass subagents a bounded text brief rather than inheriting the full parent rollout.",
    "Use --apply-fork-limit to cap subagent fan-out after reviewing the automatic config backup.",
    "Exit every Codex writer before using the supported codex delete command; never delete an actively written rollout.",
    "Reconcile external writes before replaying any operation after a storage or UI failure.",
  ],
  limits,
}

console.log(JSON.stringify(result, null, 2))
if (status !== "safe" && !args["no-fail"]) process.exit(2)
