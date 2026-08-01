import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { nowIso, randomId, sha256, stateRoot, writeJsonAtomic } from "./lib.mjs"

const DEFAULT_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"])

function numberValue(raw, name, fallback, { integer = false, minimum = 0 } = {}) {
  const value = raw === undefined || raw === null || raw === "" ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${minimum}`)
  }
  return value
}

export function parsePsOutput(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss_mib: Math.round((Number(match[3]) / 1024) * 100) / 100,
      command: match[4].slice(0, 4096),
    }))
}

export function descendantsOf(targetPid, processes) {
  const children = new Map()
  for (const process of processes) {
    const list = children.get(process.ppid) || []
    list.push(process)
    children.set(process.ppid, list)
  }
  const descendants = []
  const queue = [...(children.get(targetPid) || [])]
  const seen = new Set()
  while (queue.length > 0) {
    const process = queue.shift()
    if (!process || seen.has(process.pid)) continue
    seen.add(process.pid)
    descendants.push(process)
    queue.push(...(children.get(process.pid) || []))
  }
  return descendants
}

export function summarizeProcessSample(processes, targetPid, observedAt = nowIso()) {
  const target = processes.find((process) => process.pid === targetPid)
  if (!target) throw new Error(`Process ${targetPid} was not found`)
  const descendants = descendantsOf(targetPid, processes)
  const descendantRssMiB = Math.round(descendants.reduce((sum, process) => sum + process.rss_mib, 0) * 100) / 100
  return {
    observed_at: observedAt,
    target,
    descendants: {
      total: descendants.length,
      rss_mib: descendantRssMiB,
      top_rss: [...descendants].sort((left, right) => right.rss_mib - left.rss_mib).slice(0, 20),
    },
    tree_rss_mib: Math.round((target.rss_mib + descendantRssMiB) * 100) / 100,
  }
}

export function evaluateMemorySamples(samples, limits) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("At least one memory sample is required")
  const first = samples[0]
  const last = samples.at(-1)
  const growthMiB = Math.round((last.tree_rss_mib - first.tree_rss_mib) * 100) / 100
  const growthRatio = first.tree_rss_mib > 0 ? growthMiB / first.tree_rss_mib : 0
  const reasons = []

  if (last.target.rss_mib >= limits.targetRssMiB) {
    reasons.push(`target_rss_mib=${last.target.rss_mib}>=${limits.targetRssMiB}`)
  }
  if (last.tree_rss_mib >= limits.treeRssMiB) {
    reasons.push(`tree_rss_mib=${last.tree_rss_mib}>=${limits.treeRssMiB}`)
  }
  if (samples.length >= 2 && growthMiB >= limits.growthMiB && growthRatio >= limits.growthRatio) {
    reasons.push(`tree_growth_mib=${growthMiB}>=${limits.growthMiB}`)
    reasons.push(`tree_growth_ratio=${growthRatio.toFixed(3)}>=${limits.growthRatio}`)
  }

  return {
    status: reasons.length === 0 ? "healthy" : "drain_required",
    reasons,
    first_tree_rss_mib: first.tree_rss_mib,
    final_tree_rss_mib: last.tree_rss_mib,
    growth_mib: growthMiB,
    growth_ratio: Math.round(growthRatio * 10000) / 10000,
  }
}

function collectProcessTable() {
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error(`memory-watch supports macOS and Linux; received ${process.platform}`)
  }
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`ps failed with exit code ${result.status}: ${result.stderr.trim()}`)
  return parsePsOutput(result.stdout)
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseCommand(raw, name) {
  if (!raw) return null
  const command = JSON.parse(raw)
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error(`${name} must be a non-empty JSON string array`)
  }
  return command
}

function executeCommand(command, environment = {}, stdio = "inherit") {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio,
      shell: false,
    })
    child.on("error", (error) => resolve({ exit_code: null, signal: null, error: error.message }))
    child.on("close", (code, signal) => resolve({ exit_code: code, signal, error: null }))
  })
}

function parseSubcommand(argv) {
  const [subcommand, ...rest] = argv
  if (!subcommand || !new Set(["memory-watch", "launch"]).has(subcommand)) {
    throw new Error("Usage: codex-runtime-continuity-guard.mjs <memory-watch|launch> [options]")
  }
  return { subcommand, argv: rest }
}

function parseNamedArgs(argv) {
  const separator = argv.indexOf("--")
  const head = separator === -1 ? argv : argv.slice(0, separator)
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1)
  const args = { _: [] }
  for (let index = 0; index < head.length; index += 1) {
    const value = head[index]
    if (!value.startsWith("--")) {
      args._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = head[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return { args, passthrough }
}

function routeConflict(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (["--model", "-m", "--profile", "-p", "--oss", "--local-provider"].includes(value)) return value
    if (value.startsWith("--model=") || value.startsWith("--profile=") || value.startsWith("--local-provider=")) return value
    if (["-c", "--config"].includes(value)) {
      const override = args[index + 1] || ""
      if (/^(model|model_provider|model_reasoning_effort)\s*=/.test(override)) return `${value} ${override}`
      index += 1
      continue
    }
    if (value.startsWith("--config=")) {
      const override = value.slice("--config=".length)
      if (/^(model|model_provider|model_reasoning_effort)\s*=/.test(override)) return value
    }
  }
  return null
}

export function buildPinnedLaunchPlan(options) {
  const approvedModels = (options.approvedModels || DEFAULT_MODELS).filter(Boolean)
  const model = options.model
  const reasoningEffort = options.reasoningEffort || "medium"
  if (!model) throw new Error("An explicit --model is required")
  if (!approvedModels.includes(model)) throw new Error(`Model ${model} is not in the approved OpenAI allowlist`)
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw new Error(`Unsupported reasoning effort: ${reasoningEffort}`)
  const conflict = routeConflict(options.passthrough || [])
  if (conflict) throw new Error(`Conflicting route selector is not allowed in passthrough arguments: ${conflict}`)

  const binary = options.binary || process.env.CODEX_BIN || "codex"
  const operationId = options.operationId || process.env.OPERATOR_OPERATION_ID || randomId("codex-operation")
  const args = [
    "--model",
    model,
    "-c",
    "model_provider=openai",
    "-c",
    `model_reasoning_effort=${reasoningEffort}`,
    ...(options.passthrough || []),
  ]
  return {
    operation_id: operationId,
    provider: "openai",
    model,
    reasoning_effort: reasoningEffort,
    automatic_model_selection: false,
    gateway: null,
    fallback_chain: [],
    binary,
    args,
    cwd: path.resolve(options.cwd || process.cwd()),
    argv_sha256: sha256(JSON.stringify([binary, ...args])),
  }
}

async function memoryWatch(argv) {
  const { args } = parseNamedArgs(argv)
  const targetPid = numberValue(args.pid || process.env.CODEX_APP_SERVER_PID, "pid", NaN, { integer: true, minimum: 2 })
  const sampleCount = numberValue(args.samples || process.env.OPERATOR_APP_SERVER_MEMORY_SAMPLES, "samples", 3, {
    integer: true,
    minimum: 1,
  })
  const intervalMs = numberValue(args["interval-ms"] || process.env.OPERATOR_APP_SERVER_MEMORY_INTERVAL_MS, "interval-ms", 5000, {
    integer: true,
    minimum: 0,
  })
  const limits = {
    targetRssMiB: numberValue(
      args["target-rss-threshold-mib"] || process.env.OPERATOR_APP_SERVER_TARGET_RSS_MIB,
      "target-rss-threshold-mib",
      6144,
    ),
    treeRssMiB: numberValue(
      args["tree-rss-threshold-mib"] || process.env.OPERATOR_APP_SERVER_TREE_RSS_MIB,
      "tree-rss-threshold-mib",
      8192,
    ),
    growthMiB: numberValue(
      args["growth-threshold-mib"] || process.env.OPERATOR_APP_SERVER_GROWTH_MIB,
      "growth-threshold-mib",
      1024,
    ),
    growthRatio: numberValue(
      args["growth-ratio"] || process.env.OPERATOR_APP_SERVER_GROWTH_RATIO,
      "growth-ratio",
      0.25,
    ),
  }

  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(summarizeProcessSample(collectProcessTable(), targetPid))
    if (index + 1 < sampleCount && intervalMs > 0) await sleep(intervalMs)
  }
  const evaluation = evaluateMemorySamples(samples, limits)
  const snapshot = {
    observed_at: nowIso(),
    platform: process.platform,
    target_pid: targetPid,
    thresholds: limits,
    evaluation,
    samples,
  }
  const snapshotDir = path.resolve(args["snapshot-dir"] || path.join(stateRoot(args), "appserver-memory-watch"))
  const snapshotFile = path.join(snapshotDir, `${snapshot.observed_at.replace(/[:.]/g, "-")}-pid-${targetPid}.json`)
  writeJsonAtomic(snapshotFile, snapshot)

  if (args.json) console.log(JSON.stringify({ ...snapshot, snapshot_file: snapshotFile }))
  else {
    console.log(`Codex app-server ${targetPid}: ${evaluation.status}`)
    console.log(`Tree RSS ${evaluation.first_tree_rss_mib} -> ${evaluation.final_tree_rss_mib} MiB`)
    console.log(`Snapshot: ${snapshotFile}`)
    if (evaluation.reasons.length > 0) console.error(`Drain reasons: ${evaluation.reasons.join(", ")}`)
  }

  if (evaluation.status === "healthy") return 0
  if (!args["execute-recovery"]) return 2
  const recoveryCommand = parseCommand(
    process.env.OPERATOR_APP_SERVER_RECOVERY_COMMAND,
    "OPERATOR_APP_SERVER_RECOVERY_COMMAND",
  )
  if (!recoveryCommand) throw new Error("Recovery requested but OPERATOR_APP_SERVER_RECOVERY_COMMAND is not configured")
  const recovery = await executeCommand(recoveryCommand, {
    CODEX_APP_SERVER_PID: String(targetPid),
    OPERATOR_APP_SERVER_SNAPSHOT: snapshotFile,
    OPERATOR_APP_SERVER_RECOVERY_REASON: "memory_threshold_exceeded",
  })
  writeJsonAtomic(snapshotFile, { ...snapshot, recovery: { ...recovery, completed_at: nowIso() } })
  if (recovery.exit_code !== 0) throw new Error(`Recovery command failed with exit code ${recovery.exit_code}`)
  console.log("Recovery command completed; run a fresh-route canary before releasing queued work")
  return 0
}

async function launchPinned(argv) {
  const { args, passthrough } = parseNamedArgs(argv)
  const approvedModels = String(process.env.OPERATOR_APPROVED_OPENAI_MODELS || DEFAULT_MODELS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const plan = buildPinnedLaunchPlan({
    approvedModels,
    model: args.model || process.env.OPERATOR_CODEX_MODEL,
    reasoningEffort: args["reasoning-effort"] || process.env.OPERATOR_CODEX_REASONING_EFFORT,
    binary: args.binary,
    operationId: args["operation-id"],
    cwd: args.cwd,
    passthrough,
  })
  const receiptDir = path.resolve(args["receipt-dir"] || path.join(stateRoot(args), "model-pin"))
  const receiptFile = path.join(receiptDir, `${nowIso().replace(/[:.]/g, "-")}-${plan.operation_id}.json`)
  const receipt = { created_at: nowIso(), status: args["dry-run"] ? "dry_run" : "starting", ...plan }
  writeJsonAtomic(receiptFile, receipt)

  if (args.json || args["dry-run"]) console.log(JSON.stringify({ ...receipt, receipt_file: receiptFile }))
  else console.log(`Launching pinned Codex route: ${plan.model} (${plan.reasoning_effort})`)
  if (args["dry-run"]) return 0

  const result = await new Promise((resolve) => {
    const child = spawn(plan.binary, plan.args, {
      cwd: plan.cwd,
      env: {
        ...process.env,
        OPERATOR_OPERATION_ID: plan.operation_id,
        OPERATOR_EXPECTED_PROVIDER: plan.provider,
        OPERATOR_EXPECTED_MODEL: plan.model,
        OPERATOR_EXPECTED_REASONING_EFFORT: plan.reasoning_effort,
      },
      stdio: "inherit",
      shell: false,
    })
    child.on("error", (error) => resolve({ exit_code: null, signal: null, error: error.message }))
    child.on("close", (code, signal) => resolve({ exit_code: code, signal, error: null }))
  })
  writeJsonAtomic(receiptFile, { ...receipt, status: result.exit_code === 0 ? "completed" : "failed", ...result, completed_at: nowIso() })
  if (result.error) throw new Error(result.error)
  return result.exit_code ?? 70
}

async function main() {
  try {
    const { subcommand, argv } = parseSubcommand(process.argv.slice(2))
    const code = subcommand === "memory-watch" ? await memoryWatch(argv) : await launchPinned(argv)
    process.exitCode = code
  } catch (error) {
    console.error(error.message)
    process.exitCode = 64
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entry === import.meta.url) await main()
