import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { nowIso, parseArgs, sha256, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const targetPid = args.pid || process.env.CODEX_APP_SERVER_PID ? Number(args.pid || process.env.CODEX_APP_SERVER_PID) : null
if (targetPid !== null && (!Number.isInteger(targetPid) || targetPid <= 1)) {
  console.error("Usage: bun operator:cua-worker-guard [--pid <codex-app-server-pid>] [--json] [--execute-recovery]")
  process.exit(2)
}

const fixtureFile = args["process-list-file"] ? path.resolve(String(args["process-list-file"])) : null
if (!fixtureFile && !["darwin", "linux"].includes(process.platform)) {
  console.error("The CUA worker guard currently supports macOS and Linux process inspection")
  process.exit(64)
}

const limits = {
  workers: Number(args["worker-threshold"] || process.env.OPERATOR_CUA_WORKER_THRESHOLD || 8),
  oldestSeconds: Number(args["oldest-seconds-threshold"] || process.env.OPERATOR_CUA_OLDEST_SECONDS_THRESHOLD || 3600),
  rssMiB: Number(args["rss-threshold-mib"] || process.env.OPERATOR_CUA_RSS_THRESHOLD_MIB || 256),
}

for (const [name, value] of Object.entries(limits)) {
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Invalid threshold ${name}: ${value}`)
    process.exit(2)
  }
}

function parseElapsed(raw) {
  const value = String(raw || "").trim()
  if (!value) return 0
  let days = 0
  let clock = value
  if (value.includes("-")) {
    const parts = value.split("-", 2)
    days = Number(parts[0]) || 0
    clock = parts[1]
  }
  const fields = clock.split(":").map((part) => Number(part) || 0)
  let hours = 0
  let minutes = 0
  let seconds = 0
  if (fields.length === 3) [hours, minutes, seconds] = fields
  else if (fields.length === 2) [minutes, seconds] = fields
  else if (fields.length === 1) [seconds] = fields
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

function readProcessList() {
  if (fixtureFile) return fs.readFileSync(fixtureFile, "utf8")
  return execFileSync("ps", ["-axo", "pid=,ppid=,state=,etime=,rss=,command="], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

function parseProcessList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      state: match[3],
      elapsed_seconds: parseElapsed(match[4]),
      rss_mib: Math.round((Number(match[5]) / 1024) * 100) / 100,
      command: match[6],
    }))
}

function isAppServer(process) {
  return /(?:^|[\s/])codex(?:\.exe)?(?:\s|$).*\bapp-server\b/i.test(process.command)
}

function isCuaWorker(process) {
  return /(?:^|[\\/])cua_node[\\/](?:bin[\\/])?node_repl(?:\.exe)?(?:\s|$)/i.test(process.command)
}

function parseCommand(raw, name) {
  if (!raw) return null
  const command = JSON.parse(raw)
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error(`${name} must be a non-empty JSON string array`)
  }
  return command
}

function executeRecovery(command, snapshotFile, appServerPids) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_APP_SERVER_PID: targetPid ? String(targetPid) : "",
        OPERATOR_CUA_APP_SERVER_PIDS: JSON.stringify(appServerPids),
        OPERATOR_CUA_WORKER_SNAPSHOT: snapshotFile,
        OPERATOR_CUA_WORKER_RECOVERY_REASON: "cua_worker_threshold_exceeded",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => resolve({ exit_code: null, error: error.message, stdout, stderr }))
    child.on("close", (code, signal) => resolve({ exit_code: code, signal, stdout, stderr }))
  })
}

let processes
try {
  processes = parseProcessList(readProcessList())
} catch (error) {
  console.error(`Unable to inspect Codex CUA workers: ${error.message}`)
  process.exit(69)
}

const appServers = processes.filter(isAppServer)
const appServerPids = new Set(appServers.map((process) => process.pid))
if (targetPid !== null && !appServerPids.has(targetPid)) {
  console.error(`Codex app-server process ${targetPid} was not found`)
  process.exit(69)
}

const workers = processes.filter((process) => {
  if (!isCuaWorker(process)) return false
  return targetPid !== null ? process.ppid === targetPid : appServerPids.has(process.ppid)
})
const oldestSeconds = workers.reduce((max, worker) => Math.max(max, worker.elapsed_seconds), 0)
const rssMiB = Math.round(workers.reduce((sum, worker) => sum + worker.rss_mib, 0) * 100) / 100
const reasons = []
if (workers.length >= limits.workers) reasons.push(`workers=${workers.length}>=${limits.workers}`)
if (oldestSeconds >= limits.oldestSeconds) reasons.push(`oldest_seconds=${oldestSeconds}>=${limits.oldestSeconds}`)
if (rssMiB >= limits.rssMiB) reasons.push(`rss_mib=${rssMiB}>=${limits.rssMiB}`)

const snapshot = {
  observed_at: nowIso(),
  platform: process.platform,
  target_app_server_pid: targetPid,
  app_servers: appServers.map((process) => ({
    pid: process.pid,
    ppid: process.ppid,
    state: process.state,
    elapsed_seconds: process.elapsed_seconds,
    command_sha256: sha256(process.command),
  })),
  workers: {
    total: workers.length,
    oldest_seconds: oldestSeconds,
    rss_mib: rssMiB,
    items: workers.map((worker) => ({
      pid: worker.pid,
      ppid: worker.ppid,
      state: worker.state,
      elapsed_seconds: worker.elapsed_seconds,
      rss_mib: worker.rss_mib,
      executable: path.basename(worker.command.split(/\s+/)[0] || "node_repl"),
      command_sha256: sha256(worker.command),
    })),
  },
  thresholds: limits,
  status: reasons.length === 0 ? "healthy" : "recovery_required",
  block_new_desktop_automations: reasons.length > 0,
  reasons,
}

const snapshotDir = path.resolve(args["snapshot-dir"] || path.join(stateRoot(args), "cua-worker-guard"))
const snapshotFile = path.join(snapshotDir, `${snapshot.observed_at.replace(/[:.]/g, "-")}.json`)
writeJsonAtomic(snapshotFile, snapshot)

if (args.json) console.log(JSON.stringify({ ...snapshot, snapshot_file: snapshotFile }))
else {
  console.log(`Codex CUA workers: ${snapshot.status}`)
  console.log(`App servers ${appServers.length}; workers ${workers.length}; oldest ${oldestSeconds}s; RSS ${rssMiB} MiB`)
  console.log(`Snapshot: ${snapshotFile}`)
  if (reasons.length > 0) console.error(`Recovery reasons: ${reasons.join(", ")}`)
}

if (reasons.length === 0) process.exit(0)
if (!args["execute-recovery"]) process.exit(2)

let recoveryCommand
try {
  recoveryCommand = parseCommand(process.env.OPERATOR_CUA_WORKER_RECOVERY_COMMAND, "OPERATOR_CUA_WORKER_RECOVERY_COMMAND")
} catch (error) {
  console.error(error.message)
  process.exit(64)
}
if (!recoveryCommand) {
  console.error("Recovery was requested but OPERATOR_CUA_WORKER_RECOVERY_COMMAND is not configured")
  process.exit(64)
}

const recovery = await executeRecovery(recoveryCommand, snapshotFile, [...appServerPids])
writeJsonAtomic(snapshotFile, { ...snapshot, recovery: { ...recovery, completed_at: nowIso() } })
if (recovery.exit_code !== 0) {
  console.error(`CUA worker recovery command failed with exit code ${recovery.exit_code}`)
  process.exit(70)
}
console.log("CUA worker recovery command completed; verify all job-owned workers exited before releasing queued work")
