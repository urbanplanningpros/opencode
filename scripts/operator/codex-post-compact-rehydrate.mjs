import fs from "node:fs"
import path from "node:path"
import { nowIso, parseArgs, readJson, sha256, stateRoot } from "./lib.mjs"

const MAX_CONTEXT_BYTES = 64 * 1024
const APPROVED_PROVIDERS = new Set([null, undefined, "", "openai", "local"])
const FORBIDDEN_ROUTE_PATTERNS = [
  /anthropic/i,
  /claude/i,
  /manus/i,
  /openrouter/i,
  /bedrock/i,
  /vertex/i,
  /copilot/i,
  /gateway/i,
]

function fail(message) {
  console.error(message)
  process.exit(2)
}

function readText(file, fallback = "") {
  if (!fs.existsSync(file)) return fallback
  return fs.readFileSync(file, "utf8")
}

function atomicWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, value, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function routeValues(manifest, current) {
  const values = [current.active_provider, current.active_model]
  for (const attempt of Array.isArray(current.attempts) ? current.attempts : []) {
    values.push(attempt?.provider, attempt?.model)
  }
  const route = manifest.route_identity || {}
  values.push(...(Array.isArray(route.approved_providers) ? route.approved_providers : []))
  values.push(...(Array.isArray(route.approved_models) ? route.approved_models : []))
  return values.filter((value) => typeof value === "string")
}

function assertApprovedRoute(manifest, current) {
  if (!APPROVED_PROVIDERS.has(current.active_provider)) {
    fail(`Unapproved active provider in task state: ${String(current.active_provider)}`)
  }

  for (const value of routeValues(manifest, current)) {
    if (FORBIDDEN_ROUTE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail(`Prohibited provider, gateway, or automatic model route detected: ${value}`)
    }
  }
}

function bounded(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (Buffer.byteLength(text, "utf8") <= MAX_CONTEXT_BYTES) return text
  return `${text.slice(0, MAX_CONTEXT_BYTES)}\n\n[${label} truncated by operator rehydration guard]`
}

const args = parseArgs(process.argv.slice(2))
const taskId = args["task-id"] || process.env.OPERATOR_TASK_ID
if (!taskId) {
  fail("Usage: bun operator:rehydrate --task-id <task-id> [--state-dir <path>] [--json]")
}

const root = stateRoot(args)
const taskDir = path.join(root, "tasks", taskId)
const files = {
  manifest: path.join(taskDir, "manifest.json"),
  current: path.join(taskDir, "current-state.json"),
  decisions: path.join(taskDir, "decisions.json"),
  changedFiles: path.join(taskDir, "changed-files.json"),
  continuation: path.join(taskDir, "continuation-prompt.md"),
  context: path.join(taskDir, "rehydration-context.md"),
  state: path.join(taskDir, "rehydration-state.json"),
}

for (const required of [files.manifest, files.current, files.decisions, files.changedFiles, files.continuation]) {
  if (!fs.existsSync(required)) fail(`Missing operator task state: ${required}`)
}

const manifest = readJson(files.manifest)
const current = readJson(files.current)
const decisions = readJson(files.decisions)
const changedFiles = readJson(files.changedFiles)
const continuation = readText(files.continuation)

if (manifest.task_id !== taskId || current.task_id !== taskId) {
  fail("Task state identifiers do not match the requested task ID")
}

if (manifest.write_intent && (!manifest.operation_id || !manifest.idempotency_key)) {
  fail("Write-intent tasks require both operation_id and idempotency_key before rehydration")
}

assertApprovedRoute(manifest, current)

const generatedAt = nowIso()
const acceptance = Array.isArray(manifest.acceptance_criteria) ? manifest.acceptance_criteria : []
const prohibited = Array.isArray(manifest.prohibited_actions) ? manifest.prohibited_actions : []
const context = `# Operator post-compaction rehydration\n\nGenerated: ${generatedAt}\nTask: ${taskId}\nOperation: ${manifest.operation_id || "none"}\nStatus: ${current.status || "unknown"}\nActive provider: ${current.active_provider || "not started"}\nRisk: ${manifest.risk || "unknown"}\nWrite intent: ${Boolean(manifest.write_intent)}\nExternal write verified: ${Boolean(current.external_write_verified)}\n\n## Authority\n\nThis provider-neutral task state is authoritative after context compaction. Do not infer completion from a resumed transcript. Reconcile any uncertain external write before replay. Use only the approved direct OpenAI or explicitly authorized local route.\n\n## Objective\n\n${bounded(manifest.objective || "", "objective")}\n\n## Acceptance criteria\n\n${acceptance.map((item) => `- ${item}`).join("\n") || "- Complete the objective and preserve verification evidence."}\n\n## Prohibited actions\n\n${prohibited.map((item) => `- ${item}`).join("\n") || "- None recorded."}\n\n## Decisions\n\n${bounded(decisions, "decisions")}\n\n## Changed files\n\n${bounded(changedFiles, "changed files")}\n\n## Continuation prompt\n\n${bounded(continuation, "continuation prompt")}\n`

atomicWriteText(files.context, context)
const digest = sha256(context)
const sourceDigests = Object.fromEntries(
  [files.manifest, files.current, files.decisions, files.changedFiles, files.continuation].map((file) => [
    path.basename(file),
    sha256(fs.readFileSync(file)),
  ]),
)
atomicWriteText(
  files.state,
  `${JSON.stringify(
    {
      task_id: taskId,
      generated_at: generatedAt,
      context_path: files.context,
      context_sha256: digest,
      source_sha256: sourceDigests,
      active_provider: current.active_provider || null,
      safe_to_continue: true,
    },
    null,
    2,
  )}\n`,
)

if (args.json) {
  console.log(
    JSON.stringify({
      task_id: taskId,
      context_path: files.context,
      context_sha256: digest,
      safe_to_continue: true,
    }),
  )
} else {
  process.stdout.write(context)
}
