import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { nowIso, parseArgs, readJson, repoRoot, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
if (!args.task) {
  console.error("Usage: bun operator:route --task <manifest.json> [--profile continuity]")
  process.exit(2)
}

const config = readJson(path.join(repoRoot, "config/operator-routing.json"))
const profileName = args.profile || process.env.OPERATOR_INCIDENT_PROFILE || config.defaultProfile
const profile = config.profiles[profileName]
if (!profile) {
  console.error(`Unknown routing profile: ${profileName}`)
  process.exit(2)
}

const manifestPath = path.resolve(args.task)
const manifest = readJson(manifestPath)
if (manifest.write_intent && config.execution.requireIdempotencyKeyForWrites && !manifest.idempotency_key) {
  console.error("Write task rejected: idempotency_key is required")
  process.exit(64)
}

const taskDir = path.dirname(manifestPath)
const root = stateRoot(args)
const breakerFile = path.join(root, "circuit-breakers.json")
const breakers = fs.existsSync(breakerFile) ? readJson(breakerFile) : {}
const stateFile = path.join(taskDir, "current-state.json")
const state = fs.existsSync(stateFile)
  ? readJson(stateFile)
  : { task_id: manifest.task_id, status: "queued", active_provider: null, attempts: [], updated_at: nowIso() }

const prompt = [
  "You are continuing a provider-neutral operator task.",
  `Task ID: ${manifest.task_id}`,
  `Operation ID: ${manifest.operation_id}`,
  `Objective: ${manifest.objective}`,
  "Acceptance criteria:",
  ...manifest.acceptance_criteria.map((item) => `- ${item}`),
  `Allowed paths: ${(manifest.allowed_paths || []).join(", ") || "not specified; minimize scope"}`,
  "Prohibited actions:",
  ...(manifest.prohibited_actions || []).map((item) => `- ${item}`),
  "Preserve current state, verify all changes, and produce a continuation summary for another provider.",
].join("\n")

function parseCommand(provider) {
  const envName = config.providers[provider].commandEnv
  const raw = process.env[envName]
  if (!raw) return null
  let command
  try {
    command = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${envName} must be a JSON array, for example [\"codex\",\"exec\",\"-\"]: ${error.message}`)
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error(`${envName} must be a non-empty JSON string array`)
  }
  return command
}

function breakerOpen(provider) {
  const breaker = breakers[provider]
  if (!breaker || breaker.failures < config.circuitBreaker.failureThreshold) return false
  const elapsed = Date.now() - new Date(breaker.last_failure_at).getTime()
  return elapsed < config.circuitBreaker.cooldownSeconds * 1000
}

function execute(provider, command) {
  return new Promise((resolve) => {
    const startedAt = nowIso()
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, OPERATOR_TASK_ID: manifest.task_id, OPERATOR_OPERATION_ID: manifest.operation_id },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), config.execution.timeoutSeconds * 1000)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ provider, started_at: startedAt, ended_at: nowIso(), exit_code: null, error: error.message, stdout, stderr })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ provider, started_at: startedAt, ended_at: nowIso(), exit_code: code, signal, stdout, stderr })
    })
    child.stdin.end(prompt)
  })
}

let success = false
for (const provider of profile.order) {
  if (!config.providers[provider]?.enabled) continue
  if (breakerOpen(provider)) {
    state.attempts.push({ provider, skipped: "circuit_open", at: nowIso() })
    continue
  }
  const command = parseCommand(provider)
  if (!command) {
    state.attempts.push({ provider, skipped: "command_not_configured", at: nowIso() })
    continue
  }

  state.status = "running"
  state.active_provider = provider
  state.updated_at = nowIso()
  writeJsonAtomic(stateFile, state)

  const result = await execute(provider, command)
  const logFile = path.join(taskDir, `attempt-${String(state.attempts.length + 1).padStart(2, "0")}-${provider}.json`)
  writeJsonAtomic(logFile, result)
  state.attempts.push({ provider, exit_code: result.exit_code, log: path.basename(logFile), at: nowIso() })

  if (result.exit_code === 0) {
    breakers[provider] = { failures: 0, last_success_at: nowIso() }
    state.status = config.execution.verifyAfterExecution ? "awaiting_verification" : "completed"
    state.active_provider = provider
    state.updated_at = nowIso()
    fs.writeFileSync(
      path.join(taskDir, "continuation-prompt.md"),
      `# Continuation prompt\n\nProvider ${provider} completed execution. Verify acceptance criteria before closing.\n\n## Output\n\n${result.stdout}\n`,
    )
    success = true
    break
  }

  const previous = breakers[provider] || { failures: 0 }
  breakers[provider] = { failures: previous.failures + 1, last_failure_at: nowIso(), last_exit_code: result.exit_code }
  fs.writeFileSync(
    path.join(taskDir, "continuation-prompt.md"),
    `# Continuation prompt\n\nProvider ${provider} failed. Continue from the persisted manifest and inspect ${path.basename(logFile)}. Do not repeat completed writes.\n`,
  )

  if (manifest.write_intent && manifest.handoff_safe === false) {
    state.status = "requires_reconciliation"
    state.updated_at = nowIso()
    break
  }
}

writeJsonAtomic(breakerFile, breakers)
writeJsonAtomic(stateFile, state)
if (!success) {
  console.error(`No provider completed task ${manifest.task_id}; state preserved at ${taskDir}`)
  process.exit(69)
}
console.log(`Task ${manifest.task_id} executed by ${state.active_provider}; verification required`)
