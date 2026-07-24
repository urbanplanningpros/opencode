import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { nowIso, parseArgs, readJson, repoRoot, sha256, stateRoot, writeJsonAtomic } from "./lib.mjs"

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
  : {
      task_id: manifest.task_id,
      status: "queued",
      active_provider: null,
      active_model: null,
      attempts: [],
      updated_at: nowIso(),
    }
const providerCanaryBucket = Number.parseInt(sha256(manifest.task_id).slice(0, 8), 16) % 100
const useProviderCanary =
  profile.canary &&
  (!profile.canary.readOnly || !manifest.write_intent) &&
  providerCanaryBucket < profile.canary.percent
const providerOrder = useProviderCanary
  ? [profile.canary.provider, ...profile.order.filter((provider) => provider !== profile.canary.provider)]
  : profile.order

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
  const command = JSON.parse(raw)
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error(`${envName} must be a non-empty JSON string array`)
  }
  return command
}

function modelOrder(provider) {
  const models = config.providers[provider].models
  const candidateBucket = Number.parseInt(sha256(`${manifest.task_id}:${provider}:model`).slice(0, 8), 16) % 100
  const useCandidate =
    models.candidate &&
    (!models.candidate.readOnly || !manifest.write_intent) &&
    candidateBucket < models.candidate.percent
  const primary = { ...models.primary, lane: "primary" }
  const fallbacks = models.fallbacks.map((model) => ({ ...model, lane: "fallback" }))
  if (!useCandidate) return [primary, ...fallbacks]
  return [{ ...models.candidate, lane: "candidate" }, primary, ...fallbacks]
}

function breakerKey(provider, model) {
  return `${provider}:${model}`
}

function breakerOpen(provider, model) {
  const breaker = breakers[breakerKey(provider, model)]
  if (!breaker || breaker.failures < config.circuitBreaker.failureThreshold) return false
  return Date.now() - new Date(breaker.last_failure_at).getTime() < config.circuitBreaker.cooldownSeconds * 1000
}

function delay(attempt) {
  const base = config.execution.baseDelaySeconds * 1000 * 2 ** attempt
  const jitter = config.execution.jitter ? Math.floor(Math.random() * Math.max(1, base * 0.25)) : 0
  return new Promise((resolve) => setTimeout(resolve, base + jitter))
}

function execute(provider, modelRoute, command) {
  return new Promise((resolve) => {
    const startedAt = nowIso()
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPERATOR_TASK_ID: manifest.task_id,
        OPERATOR_OPERATION_ID: manifest.operation_id,
        OPERATOR_PROVIDER: provider,
        OPERATOR_MODEL: modelRoute.id,
        OPERATOR_MODEL_LANE: modelRoute.lane,
        OPERATOR_MODEL_POLICY: JSON.stringify(modelRoute.requestPolicy || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5000).unref()
    }, config.execution.timeoutSeconds * 1000)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({
        provider,
        model: modelRoute.id,
        lane: modelRoute.lane,
        request_policy: modelRoute.requestPolicy || {},
        started_at: startedAt,
        ended_at: nowIso(),
        exit_code: null,
        error: error.message,
        stdout,
        stderr,
      })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({
        provider,
        model: modelRoute.id,
        lane: modelRoute.lane,
        request_policy: modelRoute.requestPolicy || {},
        started_at: startedAt,
        ended_at: nowIso(),
        exit_code: code,
        signal,
        stdout,
        stderr,
      })
    })
    child.stdin.end(prompt)
  })
}

let success = false
let requiresReconciliation = false
for (const provider of providerOrder) {
  if (!config.providers[provider]?.enabled) continue

  let command
  try {
    command = parseCommand(provider)
  } catch (error) {
    state.attempts.push({ provider, skipped: "invalid_command", error: error.message, at: nowIso() })
    continue
  }
  if (!command) {
    state.attempts.push({ provider, skipped: "command_not_configured", at: nowIso() })
    continue
  }

  for (const modelRoute of modelOrder(provider)) {
    if (breakerOpen(provider, modelRoute.id)) {
      state.attempts.push({ provider, model: modelRoute.id, skipped: "circuit_open", at: nowIso() })
      continue
    }

    const attemptsAllowed = manifest.write_intent ? 1 : config.execution.readRetries + 1
    for (let modelAttempt = 0; modelAttempt < attemptsAllowed; modelAttempt += 1) {
      state.status = "running"
      state.active_provider = provider
      state.active_model = modelRoute.id
      state.updated_at = nowIso()
      writeJsonAtomic(stateFile, state)

      const result = await execute(provider, modelRoute, command)
      const safeModel = modelRoute.id.replace(/[^a-zA-Z0-9._-]/g, "-")
      const logFile = path.join(
        taskDir,
        `attempt-${String(state.attempts.length + 1).padStart(2, "0")}-${provider}-${safeModel}.json`,
      )
      writeJsonAtomic(logFile, result)
      state.attempts.push({
        provider,
        model: modelRoute.id,
        lane: modelRoute.lane,
        exit_code: result.exit_code,
        log: path.basename(logFile),
        at: nowIso(),
      })

      const key = breakerKey(provider, modelRoute.id)
      if (result.exit_code === 0) {
        breakers[key] = { failures: 0, last_success_at: nowIso() }
        state.status = config.execution.verifyAfterExecution ? "awaiting_verification" : "completed"
        state.active_provider = provider
        state.active_model = modelRoute.id
        state.updated_at = nowIso()
        fs.writeFileSync(
          path.join(taskDir, "continuation-prompt.md"),
          `# Continuation prompt\n\nProvider ${provider} using ${modelRoute.id} completed execution. Verify acceptance criteria before closing.\n\n## Output\n\n${result.stdout}\n`,
        )
        success = true
        break
      }

      const previous = breakers[key] || { failures: 0 }
      breakers[key] = {
        failures: previous.failures + 1,
        last_failure_at: nowIso(),
        last_exit_code: result.exit_code,
      }
      fs.writeFileSync(
        path.join(taskDir, "continuation-prompt.md"),
        `# Continuation prompt\n\nProvider ${provider} using ${modelRoute.id} failed. Continue from the persisted manifest and inspect ${path.basename(logFile)}. Do not repeat completed writes.\n`,
      )

      if (manifest.write_intent && manifest.handoff_safe === false) {
        state.status = "requires_reconciliation"
        state.updated_at = nowIso()
        requiresReconciliation = true
        break
      }
      if (modelAttempt + 1 < attemptsAllowed) await delay(modelAttempt)
    }

    if (success || requiresReconciliation) break
  }

  if (success || requiresReconciliation) break
}

writeJsonAtomic(breakerFile, breakers)
writeJsonAtomic(stateFile, state)
if (!success) {
  console.error(`No provider completed task ${manifest.task_id}; state preserved at ${taskDir}`)
  process.exit(69)
}
console.log(`Task ${manifest.task_id} executed by ${state.active_provider}/${state.active_model}; verification required`)
