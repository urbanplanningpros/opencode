import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { nowIso, parseArgs, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const targetPid = Number(args.pid || process.env.CODEX_APP_SERVER_PID)
if (!Number.isInteger(targetPid) || targetPid <= 1) {
  console.error("Usage: bun operator:orphan-output-guard --pid <codex-or-parent-pid> [--json] [--execute-recovery]")
  process.exit(2)
}
if (!['linux', 'darwin'].includes(process.platform)) {
  console.error("The orphan-output guard currently supports Linux and macOS")
  process.exit(64)
}

const limits = {
  deletedBytes: Number(
    args["deleted-threshold-bytes"] || process.env.OPERATOR_ORPHAN_DELETED_THRESHOLD_BYTES || 1024 ** 3,
  ),
  singleDeletedBytes: Number(
    args["single-deleted-threshold-bytes"] ||
      process.env.OPERATOR_ORPHAN_SINGLE_DELETED_THRESHOLD_BYTES ||
      512 * 1024 ** 2,
  ),
  freeBytes: Number(args["free-threshold-bytes"] || process.env.OPERATOR_ORPHAN_FREE_THRESHOLD_BYTES || 10 * 1024 ** 3),
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

function linuxProcesses() {
  return fs
    .readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => {
      const pid = Number(entry.name)
      const stat = readText(`/proc/${pid}/stat`)
      if (!stat) return null
      const end = stat.lastIndexOf(")")
      if (end === -1) return null
      const fields = stat.slice(end + 2).trim().split(/\s+/)
      const ppid = Number(fields[1])
      const command = (readText(`/proc/${pid}/cmdline`) || "").split("\0").filter(Boolean).join(" ")
      return { pid, ppid: Number.isInteger(ppid) ? ppid : 0, command: command.slice(0, 4096) }
    })
    .filter(Boolean)
}

function unixProcesses() {
  if (process.platform === "linux") return linuxProcesses()
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || "ps failed")
  return result.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[4].slice(0, 4096) }))
}

function descendantsOf(pid, processes) {
  const children = new Map()
  for (const process of processes) {
    const values = children.get(process.ppid) || []
    values.push(process)
    children.set(process.ppid, values)
  }
  const result = []
  const queue = [processes.find((process) => process.pid === pid), ...(children.get(pid) || [])].filter(Boolean)
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

function safeName(name) {
  return {
    basename: path.basename(String(name).replace(/ \(deleted\)$/, "")),
    path_sha256: crypto.createHash("sha256").update(String(name)).digest("hex"),
  }
}

function linuxDeletedFiles(processes) {
  const files = []
  for (const process of processes) {
    const directory = `/proc/${process.pid}/fd`
    let descriptors
    try {
      descriptors = fs.readdirSync(directory)
    } catch {
      continue
    }
    for (const descriptor of descriptors) {
      const fdPath = path.join(directory, descriptor)
      let link
      try {
        link = fs.readlinkSync(fdPath)
      } catch {
        continue
      }
      if (!link.endsWith(" (deleted)")) continue
      let stat
      try {
        stat = fs.statSync(fdPath)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      files.push({
        pid: process.pid,
        fd: descriptor,
        bytes: stat.size,
        command: process.command,
        ...safeName(link),
      })
    }
  }
  return files
}

function macDeletedFiles(processes) {
  if (spawnSync("sh", ["-lc", "command -v lsof >/dev/null 2>&1"]).status !== 0) {
    throw new Error("lsof is required on macOS")
  }
  const files = []
  for (const process of processes) {
    const result = spawnSync("lsof", ["-nP", "+L1", "-p", String(process.pid), "-F", "pfsn"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
    if (![0, 1].includes(result.status ?? 1)) continue
    let current = null
    const flush = () => {
      if (!current || !Number.isFinite(current.bytes) || current.bytes <= 0) return
      files.push({
        pid: process.pid,
        fd: current.fd || null,
        bytes: current.bytes,
        command: process.command,
        ...safeName(current.name || "<deleted-open-file>"),
      })
    }
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("f")) {
        flush()
        current = { fd: line.slice(1), bytes: 0, name: "" }
        continue
      }
      if (!current) continue
      if (line.startsWith("s")) current.bytes = Number(line.slice(1))
      if (line.startsWith("n")) current.name = line.slice(1)
    }
    flush()
  }
  return files
}

function diskAvailableBytes(target) {
  const result = spawnSync("df", ["-Pk", target], { encoding: "utf8" })
  if (result.status !== 0) return null
  const lines = result.stdout.trim().split("\n")
  const fields = lines.at(-1)?.trim().split(/\s+/)
  if (!fields || fields.length < 4) return null
  const availableKiB = Number(fields[3])
  return Number.isFinite(availableKiB) ? availableKiB * 1024 : null
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
        OPERATOR_ORPHAN_OUTPUT_SNAPSHOT: snapshotFile,
        OPERATOR_ORPHAN_OUTPUT_RECOVERY_REASON: "deleted_open_file_threshold_exceeded",
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
let deletedFiles
try {
  const all = unixProcesses()
  processes = descendantsOf(targetPid, all)
  if (!processes.some((process) => process.pid === targetPid)) throw new Error(`Process ${targetPid} was not found`)
  deletedFiles = process.platform === "linux" ? linuxDeletedFiles(processes) : macDeletedFiles(processes)
} catch (error) {
  console.error(`Unable to inspect process tree ${targetPid}: ${error.message}`)
  process.exit(69)
}

const totalDeletedBytes = deletedFiles.reduce((sum, file) => sum + file.bytes, 0)
const largestDeletedBytes = deletedFiles.reduce((largest, file) => Math.max(largest, file.bytes), 0)
const diskPath = path.resolve(String(args["disk-path"] || os.tmpdir()))
const freeBytes = diskAvailableBytes(diskPath)
const reasons = []
if (totalDeletedBytes >= limits.deletedBytes) reasons.push(`deleted_bytes=${totalDeletedBytes}>=${limits.deletedBytes}`)
if (largestDeletedBytes >= limits.singleDeletedBytes) {
  reasons.push(`largest_deleted_bytes=${largestDeletedBytes}>=${limits.singleDeletedBytes}`)
}
if (freeBytes !== null && freeBytes <= limits.freeBytes) reasons.push(`free_bytes=${freeBytes}<=${limits.freeBytes}`)

const snapshot = {
  observed_at: nowIso(),
  platform: process.platform,
  target_pid: targetPid,
  process_count: processes.length,
  disk_path: diskPath,
  free_bytes: freeBytes,
  deleted_open_files: {
    count: deletedFiles.length,
    total_bytes: totalDeletedBytes,
    largest_bytes: largestDeletedBytes,
    top: [...deletedFiles].sort((left, right) => right.bytes - left.bytes).slice(0, 50),
  },
  thresholds: limits,
  status: reasons.length === 0 ? "healthy" : "recovery_required",
  reasons,
}

const snapshotDir = path.resolve(args["snapshot-dir"] || path.join(stateRoot(args), "orphan-output-guard"))
const snapshotFile = path.join(snapshotDir, `${snapshot.observed_at.replace(/[:.]/g, "-")}-pid-${targetPid}.json`)
writeJsonAtomic(snapshotFile, snapshot)

if (args["execute-recovery"] && reasons.length > 0) {
  try {
    const command = parseCommand(
      process.env.OPERATOR_ORPHAN_OUTPUT_RECOVERY_COMMAND,
      "OPERATOR_ORPHAN_OUTPUT_RECOVERY_COMMAND",
    )
    if (!command) throw new Error("OPERATOR_ORPHAN_OUTPUT_RECOVERY_COMMAND is required")
    snapshot.recovery = await executeRecovery(command, snapshotFile)
    snapshot.recovery.reaudit_required = true
    writeJsonAtomic(snapshotFile, snapshot)
  } catch (error) {
    snapshot.recovery = { exit_code: null, error: error.message, reaudit_required: true }
    writeJsonAtomic(snapshotFile, snapshot)
  }
}

if (args.json) console.log(JSON.stringify({ ...snapshot, snapshot_file: snapshotFile }, null, 2))
else {
  console.log(`Codex orphan-output guard: ${snapshot.status}`)
  console.log(`Deleted open files: ${deletedFiles.length}; bytes: ${totalDeletedBytes}; free bytes: ${freeBytes ?? "unknown"}`)
  console.log(`Snapshot: ${snapshotFile}`)
  for (const reason of reasons) console.log(`- ${reason}`)
}

process.exit(reasons.length === 0 ? 0 : 2)
