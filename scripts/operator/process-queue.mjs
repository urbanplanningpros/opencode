import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { nowIso, parseArgs, readJson, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const root = stateRoot(args)
const pendingDir = path.join(root, "queue", "pending")
const processingDir = path.join(root, "queue", "processing")
const completedDir = path.join(root, "queue", "completed")
const reconciliationDir = path.join(root, "queue", "reconciliation")
for (const directory of [pendingDir, processingDir, completedDir, reconciliationDir]) fs.mkdirSync(directory, { recursive: true })

const staleSeconds = Number(process.env.OPERATOR_PROCESSING_STALE_SECONDS || 900)
for (const candidate of fs.readdirSync(processingDir).filter((file) => file.endsWith(".json"))) {
  const file = path.join(processingDir, candidate)
  const record = readJson(file)
  if (Date.now() - new Date(record.updated_at).getTime() < staleSeconds * 1000) continue
  record.status = "requires_reconciliation"
  record.reconciliation_reason = "processing lease expired before verified completion"
  record.updated_at = nowIso()
  writeJsonAtomic(path.join(reconciliationDir, candidate), record)
  fs.rmSync(file)
}

const rawCommand = process.env.OPERATOR_ACTION_EXECUTOR_COMMAND
if (!rawCommand) {
  console.error('OPERATOR_ACTION_EXECUTOR_COMMAND is required as a JSON array, for example ["node","executor.mjs"]')
  process.exit(2)
}
const command = JSON.parse(rawCommand)
if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
  console.error("OPERATOR_ACTION_EXECUTOR_COMMAND must be a non-empty JSON string array")
  process.exit(2)
}

const candidate = fs.readdirSync(pendingDir).filter((file) => file.endsWith(".json")).sort()[0]
if (!candidate) {
  console.log("No pending actions")
  process.exit(0)
}

const pendingFile = path.join(pendingDir, candidate)
const processingFile = path.join(processingDir, candidate)
try {
  fs.renameSync(pendingFile, processingFile)
} catch (error) {
  if (error.code === "ENOENT") process.exit(0)
  throw error
}

const record = readJson(processingFile)
record.status = "processing"
record.attempt_count += 1
record.updated_at = nowIso()
writeJsonAtomic(processingFile, record)

const result = await new Promise((resolve) => {
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPERATOR_OPERATION_ID: record.operation_id,
      OPERATOR_IDEMPOTENCY_KEY: record.idempotency_key,
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  })
  let stdout = ""
  let stderr = ""
  const timeoutSeconds = Number(process.env.OPERATOR_ACTION_TIMEOUT_SECONDS || 300)
  const timer = setTimeout(() => {
    child.kill("SIGTERM")
    setTimeout(() => child.kill("SIGKILL"), 5000).unref()
  }, timeoutSeconds * 1000)
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  child.on("error", (error) => {
    clearTimeout(timer)
    resolve({ exit_code: null, error: error.message, stdout, stderr })
  })
  child.on("close", (code, signal) => {
    clearTimeout(timer)
    resolve({ exit_code: code, signal, stdout, stderr })
  })
  child.stdin.end(JSON.stringify(record))
})

let executorOutput = null
try {
  executorOutput = result.stdout ? JSON.parse(result.stdout) : null
} catch {
  executorOutput = null
}
record.executor_result = result
record.updated_at = nowIso()

if (result.exit_code === 0 && executorOutput?.verified === true) {
  record.status = "completed"
  record.verified_at = nowIso()
  writeJsonAtomic(path.join(completedDir, candidate), record)
  fs.rmSync(processingFile)
  console.log(`Completed ${record.operation_id}`)
  process.exit(0)
}

record.status = "requires_reconciliation"
record.reconciliation_reason = result.exit_code === 0 ? "executor did not return verified=true" : "executor failed or target state is uncertain"
writeJsonAtomic(path.join(reconciliationDir, candidate), record)
fs.rmSync(processingFile)
console.error(`Action ${record.operation_id} requires reconciliation; it was not retried`)
process.exit(70)
