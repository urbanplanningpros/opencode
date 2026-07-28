#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { finished } from "node:stream/promises"

function usage() {
  console.error(`Usage:
  node scripts/operator/codex-command-evidence.mjs \\
    --operation-id <stable-id> \\
    --idempotency-key <stable-key> \\
    [--evidence-root <path>] \\
    [--timeout-seconds <1-86400>] \\
    -- <command> [arguments...]

The command is executed without shell interpolation. Stdout and stderr are
streamed to the terminal and persisted in a private operation-scoped evidence
directory. Interrupted and timed-out commands retain their partial output.`)
}

function parseArgs(argv) {
  const separator = argv.indexOf("--")
  if (separator < 0) throw new Error("a -- separator is required before the command")

  const controls = argv.slice(0, separator)
  const command = argv.slice(separator + 1)
  const parsed = {
    operationId: null,
    idempotencyKey: null,
    evidenceRoot: null,
    timeoutSeconds: 1800,
    command,
  }

  for (let index = 0; index < controls.length; index += 1) {
    const item = controls[index]
    const next = controls[index + 1]
    if (item === "--operation-id") {
      parsed.operationId = next
      index += 1
    } else if (item === "--idempotency-key") {
      parsed.idempotencyKey = next
      index += 1
    } else if (item === "--evidence-root") {
      parsed.evidenceRoot = next
      index += 1
    } else if (item === "--timeout-seconds") {
      parsed.timeoutSeconds = Number(next)
      index += 1
    } else if (item === "--help" || item === "-h") {
      usage()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${item}`)
    }
  }

  if (!parsed.operationId || !/^[A-Za-z0-9._-]{1,128}$/.test(parsed.operationId)) {
    throw new Error("--operation-id must contain only letters, numbers, dots, underscores, or hyphens")
  }
  if (!parsed.idempotencyKey || parsed.idempotencyKey.length > 256) {
    throw new Error("--idempotency-key is required and must be at most 256 characters")
  }
  if (!Number.isInteger(parsed.timeoutSeconds) || parsed.timeoutSeconds < 1 || parsed.timeoutSeconds > 86400) {
    throw new Error("--timeout-seconds must be an integer from 1 through 86400")
  }
  if (parsed.command.length === 0 || parsed.command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("a non-empty command argument array is required")
  }

  return parsed
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  })
  fs.renameSync(temporary, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function ensurePrivateDirectory(directory) {
  const parent = path.dirname(directory)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (fs.existsSync(directory)) {
    const info = fs.lstatSync(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`evidence path is not a normal directory: ${directory}`)
    }
    if (fs.readdirSync(directory).length > 0) {
      throw new Error(
        `evidence already exists for this operation: ${directory}. Reconcile the existing receipt before choosing a new operation identity.`,
      )
    }
  } else {
    fs.mkdirSync(directory, { mode: 0o700 })
  }
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function terminateProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    })
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process has already exited.
    }
  }
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`codex-command-evidence: ${error.message}`)
  usage()
  process.exit(64)
}

const evidenceRoot = path.resolve(
  args.evidenceRoot || process.env.OPERATOR_COMMAND_EVIDENCE_ROOT || path.join(process.cwd(), ".operator", "command-evidence"),
)
const operationDirectory = path.join(evidenceRoot, args.operationId)
const stdoutPath = path.join(operationDirectory, "stdout.log")
const stderrPath = path.join(operationDirectory, "stderr.log")
const receiptPath = path.join(operationDirectory, "receipt.json")

try {
  ensurePrivateDirectory(operationDirectory)
} catch (error) {
  console.error(`codex-command-evidence: ${error.message}`)
  process.exit(75)
}

const startedAt = new Date().toISOString()
const commandDigest = sha256(JSON.stringify(args.command))
const idempotencyDigest = sha256(args.idempotencyKey)
const runningReceipt = {
  schema_version: 1,
  status: "running",
  operation_id: args.operationId,
  idempotency_key_sha256: idempotencyDigest,
  command_sha256: commandDigest,
  executable: path.basename(args.command[0]),
  argument_count: Math.max(args.command.length - 1, 0),
  working_directory: process.cwd(),
  started_at: startedAt,
  timeout_seconds: args.timeoutSeconds,
  stdout_path: stdoutPath,
  stderr_path: stderrPath,
  external_write_verified: false,
}
atomicWriteJson(receiptPath, runningReceipt)

const stdoutFile = fs.createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 })
const stderrFile = fs.createWriteStream(stderrPath, { flags: "wx", mode: 0o600 })
const detached = process.platform !== "win32"
const child = spawn(args.command[0], args.command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  windowsHide: true,
  detached,
  stdio: ["inherit", "pipe", "pipe"],
})

let terminalOverride = null
let requestedExitCode = null
let finalized = false
let forceKillTimer = null
let timeoutTimer = null

function requestTermination(status, exitCode, signal) {
  if (terminalOverride) return
  terminalOverride = status
  requestedExitCode = exitCode
  terminateProcessTree(child, signal)
  forceKillTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2000)
  forceKillTimer.unref()
}

process.on("SIGINT", () => requestTermination("interrupted", 130, "SIGTERM"))
process.on("SIGTERM", () => requestTermination("terminated", 143, "SIGTERM"))

timeoutTimer = setTimeout(() => requestTermination("timeout", 124, "SIGTERM"), args.timeoutSeconds * 1000)
timeoutTimer.unref()

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk)
  stdoutFile.write(chunk)
})
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk)
  stderrFile.write(chunk)
})

child.on("error", (error) => {
  if (!terminalOverride) {
    terminalOverride = "spawn_failed"
    requestedExitCode = error.code === "ENOENT" ? 127 : 69
    stderrFile.write(`Unable to start command: ${error.message}\n`)
  }
})

child.on("close", async (code, signal) => {
  if (finalized) return
  finalized = true
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (forceKillTimer) clearTimeout(forceKillTimer)

  stdoutFile.end()
  stderrFile.end()
  await Promise.allSettled([finished(stdoutFile), finished(stderrFile)])

  const stdout = fs.readFileSync(stdoutPath)
  const stderr = fs.readFileSync(stderrPath)
  const status = terminalOverride || (code === 0 ? "completed" : "failed")
  const completedAt = new Date().toISOString()
  const receipt = {
    ...runningReceipt,
    status,
    completed_at: completedAt,
    exit_code: code,
    signal: signal || null,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    partial_output_preserved: ["interrupted", "terminated", "timeout"].includes(status),
    safe_to_infer_external_write_completion: false,
    next_step:
      status === "completed"
        ? "Use destination verification, not this receipt alone, before marking any external write complete."
        : "Read the preserved output, reconcile any external destination, and do not blindly replay the command.",
  }
  atomicWriteJson(receiptPath, receipt)

  console.error(`\nCommand evidence receipt: ${receiptPath}`)
  process.exitCode = requestedExitCode ?? (Number.isInteger(code) ? code : 1)
})
