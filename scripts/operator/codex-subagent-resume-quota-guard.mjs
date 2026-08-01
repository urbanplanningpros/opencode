import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function fail(message, details = {}, code = 2) {
  console.error(JSON.stringify({ status: "blocked", message, ...details }, null, 2))
  process.exit(code)
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} not found`, { file })
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    fail(`${label} is not valid JSON`, { file, error: String(error) })
  }
}

function validateApprovedRoute(value, label) {
  const violations = []
  if (value.provider !== "openai") violations.push(`${label}.provider must be openai`)
  if (!value.model || typeof value.model !== "string") violations.push(`${label}.model must be explicit`)
  if (!value.reasoning_effort || typeof value.reasoning_effort !== "string") {
    violations.push(`${label}.reasoning_effort must be explicit`)
  }
  if (value.automatic_model_selection !== false) violations.push(`${label}.automatic_model_selection must be false`)
  if (value.gateway) violations.push(`${label}.gateway must be null`)
  if (Array.isArray(value.fallbacks) && value.fallbacks.length > 0) violations.push(`${label}.fallbacks must be empty`)
  if (violations.length > 0) fail("route policy violation", { violations })
}

function register(args) {
  const output = path.resolve(args.output || ".operator/subagent-resume-manifest.json")
  const manifest = {
    schema_version: 1,
    operation_id: args["operation-id"],
    child_id: args["child-id"],
    provider: args.provider || "openai",
    model: args.model,
    reasoning_effort: args["reasoning-effort"],
    automatic_model_selection: false,
    gateway: null,
    fallbacks: [],
    registered_at: new Date().toISOString(),
  }
  if (!manifest.operation_id || !manifest.child_id) fail("operation-id and child-id are required")
  validateApprovedRoute(manifest, "manifest")
  atomicWrite(output, manifest)
  console.log(JSON.stringify({ status: "registered", manifest_file: output, manifest }, null, 2))
}

function planResume(args) {
  const manifest = readJson(path.resolve(args.manifest || ".operator/subagent-resume-manifest.json"), "manifest")
  validateApprovedRoute(manifest, "manifest")
  if (args["native-resume-agent"] === "true" || args["native-resume-agent"] === true) {
    fail("native resume_agent is blocked because it cannot prove model and reasoning-effort continuity", {
      child_id: manifest.child_id,
      approved_route: "pinned CLI resume or pinned direct OpenAI app-server/API route",
    })
  }
  const plan = {
    status: "resume_plan_ready",
    operation_id: manifest.operation_id,
    child_id: manifest.child_id,
    route: {
      provider: manifest.provider,
      model: manifest.model,
      reasoning_effort: manifest.reasoning_effort,
      automatic_model_selection: false,
      gateway: null,
      fallbacks: [],
    },
    cli_argv: [
      "codex",
      "exec",
      "resume",
      "--model",
      manifest.model,
      "-c",
      "model_provider=openai",
      "-c",
      `model_reasoning_effort=${manifest.reasoning_effort}`,
      manifest.child_id,
    ],
    required_post_resume_receipt: ["operation_id", "child_id", "provider", "effective_model", "effective_reasoning_effort"],
  }
  console.log(JSON.stringify(plan, null, 2))
}

function verifyEffective(args) {
  const manifest = readJson(path.resolve(args.manifest || ".operator/subagent-resume-manifest.json"), "manifest")
  const receipt = readJson(path.resolve(args.receipt), "runtime receipt")
  validateApprovedRoute(manifest, "manifest")
  const mismatches = []
  if (receipt.operation_id !== manifest.operation_id) mismatches.push("operation_id")
  if (receipt.child_id !== manifest.child_id) mismatches.push("child_id")
  if (receipt.provider !== manifest.provider) mismatches.push("provider")
  if (receipt.effective_model !== manifest.model) mismatches.push("effective_model")
  if (receipt.effective_reasoning_effort !== manifest.reasoning_effort) mismatches.push("effective_reasoning_effort")
  if (mismatches.length > 0) {
    fail("resumed child route does not match its persisted route", {
      mismatches,
      expected: manifest,
      observed: receipt,
      required_action: "quarantine only this resumed child and continue through a freshly pinned approved route without replaying completed work",
    })
  }
  console.log(JSON.stringify({ status: "verified", operation_id: manifest.operation_id, child_id: manifest.child_id }, null, 2))
}

function auditQuota(args) {
  const previous = readJson(path.resolve(args.previous), "previous quota snapshot")
  const current = readJson(path.resolve(args.current), "current quota snapshot")
  const output = path.resolve(args.output || ".operator/quota-audit.json")
  const previousUsed = Number(previous.used_percent)
  const currentUsed = Number(current.used_percent)
  const previousReset = Number(previous.resets_at)
  const currentReset = Number(current.resets_at)
  if (![previousUsed, currentUsed, previousReset, currentReset].every(Number.isFinite)) {
    fail("quota snapshots require numeric used_percent and resets_at fields")
  }
  const now = Number(current.observed_at_epoch || Math.floor(Date.now() / 1000))
  const resetWasDue = now >= previousReset
  const usageDropped = previousUsed - currentUsed
  const windowReanchored = currentReset > previousReset
  const consumeReceiptPresent = Boolean(current.reset_credit_consume_receipt)
  const unexpected = usageDropped >= Number(args["drop-threshold"] || 10) && windowReanchored && !resetWasDue && !consumeReceiptPresent
  const result = {
    status: unexpected ? "unexpected_reset_requires_reconciliation" : "ok",
    checked_at: new Date().toISOString(),
    previous,
    current,
    analysis: {
      usage_drop_percent: usageDropped,
      previous_reset_was_due: resetWasDue,
      window_reanchored: windowReanchored,
      reset_credit_consume_receipt_present: consumeReceiptPresent,
    },
    required_actions: unexpected
      ? [
          "Preserve both quota snapshots and the affected operation/thread identifiers.",
          "Do not automatically redeem another reset or replay the running automation.",
          "Continue verified work while treating displayed quota and banked-reset state as untrusted.",
          "Reconcile the server-side reset event through OpenAI support or a supported usage-history surface.",
        ]
      : [],
  }
  atomicWrite(output, result)
  console.log(JSON.stringify({ ...result, audit_file: output }, null, 2))
  if (unexpected) process.exit(3)
}

const args = parseArgs(process.argv.slice(2))
const command = process.argv[2]

if (command === "register") register(args)
else if (command === "plan-resume") planResume(args)
else if (command === "verify-effective") verifyEffective(args)
else if (command === "audit-quota") auditQuota(args)
else {
  fail("unknown command", {
    supported_commands: ["register", "plan-resume", "verify-effective", "audit-quota"],
  })
}
