import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { nowIso, parseArgs, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const targetPid = Number(args.pid || process.env.CODEX_APP_SERVER_PID)
if (!Number.isInteger(targetPid) || targetPid <= 1) {
  console.error("Usage: bun operator:appserver-guard --pid <codex-app-server-pid> [--json] [--execute-recovery]")
  process.exit(2)
}
if (process.platform !== "linux" || !fs.existsSync("/proc")) {
  console.error("The Codex app-server resource guard currently requires Linux /proc")
  process.exit(64)
}

const limits = {
  fdRatio: Number(args["fd-ratio"] || process.env.OPERATOR_APP_SERVER_FD_RATIO || 0.75),
  pipes: Number(args["pipe-threshold"] || process.env.OPERATOR_APP_SERVER_PIPE_THRESHOLD || 400),
  pidfds: Number(args["pidfd-threshold"] || process.env.OPERATOR_APP_SERVER_PIDFD_THRESHOLD || 128),
  descendants: Number(args["child-threshold"] || process.env.OPERATOR_APP_SERVER_CHILD_THRESHOLD || 128),
  mcpDescendants: Number(args["mcp-child-threshold"] || process.env.OPERATOR_APP_SERVER_MCP_CHILD_THRESHOLD || 64),
  rssMiB: Number(args["rss-threshold-mib"] || process.env.OPERATOR_APP_SERVER_RSS_THRESHOLD_MIB || 8192),
  descendantRssMiB: Number(
    args["descendant-rss-threshold-mib"] || process.env.OPERATOR_APP_SERVER_DESCENDANT_RSS_THRESHOLD_MIB || 16384,
  ),
}

for (const [name, value] of Object.entries(limits)) {
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Invalid threshold ${name}: ${value}`)
    process.exit(2)
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function processInfo(pid) {
  const proc = `/proc/${pid}`
  const status = readText(path.join(proc, "status"))
  const cmdline = readText(path.join(proc, "cmdline"))
  const stat = readText(path.join(proc, "stat"))
  if (!status || !stat) return null
  const end = stat.lastIndexOf(")")
  if (end === -1) return null
  const fields = stat.slice(end + 2).trim().split(/\s+/)
  const ppid = Number(fields[1])
  const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0)
  return {
    pid,
    ppid: Number.isInteger(ppid) ? ppid : 0,
    rss_mib: Math.round((rssKiB / 1024) * 100) / 100,
    command: (cmdline || "").split("\0").filter(Boolean).join(" ").slice(0, 4096),
  }
}

function allProcesses() {
  return fs
    .readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => processInfo(Number(entry.name)))
    .filter(Boolean)
}

function descendantsOf(pid, processes) {
  const children = new Map()
  for (const process of processes) {
    const list = children.get(process.ppid) || []
    list.push(process)
    children.set(process.ppid, list)
  }
  const result = []
  const queue = [...(children.get(pid) || [])]
  const seen = new Set()
  while (queue.length > 0) {
    const process = queue.shift()
    if (!process || seen.has(process.pid)) continue
    seen.add(process.pid)
    result.push(process)
    queue.push(...(children.get(process.pid) || []))
  }
  return result
}

function fdSnapshot(pid) {
  const directory = `/proc/${pid}/fd`
  const names = fs.readdirSync(directory)
  const links = names.map((name) => {
    try {
      return fs.readlinkSync(path.join(directory, name))
    } catch {
      return "<unreadable>"
    }
  })
  return {
    total: names.length,
    pipes: links.filter((link) => link.startsWith("pipe:[")).length,
    pidfds: links.filter((link) => link === "anon_inode:[pidfd]" || link.startsWith("anon_inode:[pidfd")).length,
  }
}

function openFileLimit(pid) {
  const text = readText(`/proc/${pid}/limits`)
  const match = text?.match(/^Max open files\s+(\d+|unlimited)\s+(\d+|unlimited)/m)
  if (!match || match[1] === "unlimited") return null
  return Number(match[1])
}

function parseCommand(raw, name) {
  if (!raw) return null
  const command = JSON.parse(raw)
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error(`${name} must be a non-empty JSON string array`)
  }
  return command
}

function executeRecovery(command, snapshotFile) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_APP_SERVER_PID: String(targetPid),
        OPERATOR_APP_SERVER_SNAPSHOT: snapshotFile,
        OPERATOR_APP_SERVER_RECOVERY_REASON: "resource_threshold_exceeded",
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

let target
let fds
let descendants
try {
  const processes = allProcesses()
  target = processes.find((process) => process.pid === targetPid)
  if (!target) throw new Error(`Process ${targetPid} was not found`)
  fds = fdSnapshot(targetPid)
  descendants = descendantsOf(targetPid, processes)
} catch (error) {
  console.error(`Unable to inspect Codex app-server process ${targetPid}: ${error.message}`)
  process.exit(69)
}

const maxOpenFiles = openFileLimit(targetPid)
const fdRatio = maxOpenFiles ? fds.total / maxOpenFiles : null
const mcpDescendants = descendants.filter((process) => /(^|[\\/\s_-])mcp([\\/\s_-]|$)|model.?context.?protocol/i.test(process.command))
const descendantRssMiB = Math.round(descendants.reduce((sum, process) => sum + process.rss_mib, 0) * 100) / 100
const reasons = []
if (fdRatio !== null && fdRatio >= limits.fdRatio) reasons.push(`fd_ratio=${fdRatio.toFixed(3)}>=${limits.fdRatio}`)
if (fds.pipes >= limits.pipes) reasons.push(`pipes=${fds.pipes}>=${limits.pipes}`)
if (fds.pidfds >= limits.pidfds) reasons.push(`pidfds=${fds.pidfds}>=${limits.pidfds}`)
if (descendants.length >= limits.descendants) reasons.push(`descendants=${descendants.length}>=${limits.descendants}`)
if (mcpDescendants.length >= limits.mcpDescendants) {
  reasons.push(`mcp_descendants=${mcpDescendants.length}>=${limits.mcpDescendants}`)
}
if (target.rss_mib >= limits.rssMiB) reasons.push(`rss_mib=${target.rss_mib}>=${limits.rssMiB}`)
if (descendantRssMiB >= limits.descendantRssMiB) {
  reasons.push(`descendant_rss_mib=${descendantRssMiB}>=${limits.descendantRssMiB}`)
}

const snapshot = {
  observed_at: nowIso(),
  target: {
    ...target,
    max_open_files: maxOpenFiles,
    fd_ratio: fdRatio === null ? null : Math.round(fdRatio * 10000) / 10000,
  },
  descriptors: fds,
  descendants: {
    total: descendants.length,
    mcp_related: mcpDescendants.length,
    rss_mib: descendantRssMiB,
    top_rss: [...descendants].sort((left, right) => right.rss_mib - left.rss_mib).slice(0, 25),
  },
  thresholds: limits,
  status: reasons.length === 0 ? "healthy" : "recovery_required",
  reasons,
}

const snapshotDir = path.resolve(args["snapshot-dir"] || path.join(stateRoot(args), "appserver-guard"))
const snapshotFile = path.join(snapshotDir, `${snapshot.observed_at.replace(/[:.]/g, "-")}-pid-${targetPid}.json`)
writeJsonAtomic(snapshotFile, snapshot)

if (args.json) console.log(JSON.stringify({ ...snapshot, snapshot_file: snapshotFile }))
else {
  console.log(`Codex app-server ${targetPid}: ${snapshot.status}`)
  console.log(`FDs ${fds.total}/${maxOpenFiles ?? "unlimited"}; pipes ${fds.pipes}; pidfds ${fds.pidfds}`)
  console.log(`Descendants ${descendants.length}; MCP-related ${mcpDescendants.length}; descendant RSS ${descendantRssMiB} MiB`)
  console.log(`Snapshot: ${snapshotFile}`)
  if (reasons.length > 0) console.error(`Recovery reasons: ${reasons.join(", ")}`)
}

if (reasons.length === 0) process.exit(0)
if (!args["execute-recovery"]) process.exit(2)

let recoveryCommand
try {
  recoveryCommand = parseCommand(process.env.OPERATOR_APP_SERVER_RECOVERY_COMMAND, "OPERATOR_APP_SERVER_RECOVERY_COMMAND")
} catch (error) {
  console.error(error.message)
  process.exit(64)
}
if (!recoveryCommand) {
  console.error("Recovery was requested but OPERATOR_APP_SERVER_RECOVERY_COMMAND is not configured")
  process.exit(64)
}

const recovery = await executeRecovery(recoveryCommand, snapshotFile)
writeJsonAtomic(snapshotFile, { ...snapshot, recovery: { ...recovery, completed_at: nowIso() } })
if (recovery.exit_code !== 0) {
  console.error(`App-server recovery command failed with exit code ${recovery.exit_code}`)
  process.exit(70)
}
console.log("App-server recovery command completed; verify the fresh route before releasing queued work")
