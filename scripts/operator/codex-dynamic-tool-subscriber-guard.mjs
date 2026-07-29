import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--json") result.json = true
    else if (value === "--input") result.input = argv[++index]
    else throw new Error(`Unknown argument: ${value}`)
  }
  return result
}

function fail(message, exitCode, details = {}) {
  const output = { admitted: false, exit_code: exitCode, reason: message, ...details }
  if (args.json) console.log(JSON.stringify(output, null, 2))
  else console.error(message)
  process.exit(exitCode)
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

if (!args.input) {
  console.error("Usage: node scripts/operator/codex-dynamic-tool-subscriber-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

const inputPath = path.resolve(args.input)
let evidence
try {
  evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"))
} catch (error) {
  console.error(`Unable to read dynamic-tool evidence: ${error.message}`)
  process.exit(2)
}

const prohibitedRoute = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
if (prohibitedRoute.test(JSON.stringify(evidence))) {
  fail("Prohibited provider, gateway, or automatic-selection identifier found in dynamic-tool evidence.", 64)
}

const requiredStrings = ["thread_id", "request_id", "tool_name"]
for (const field of requiredStrings) {
  if (typeof evidence[field] !== "string" || evidence[field].trim().length === 0) {
    fail(`Missing required string field: ${field}`, 2)
  }
}
if (!Array.isArray(evidence.subscribers) || evidence.subscribers.length === 0) {
  fail("At least one thread subscriber is required.", 2)
}

const subscribers = evidence.subscribers.map((subscriber, index) => {
  if (!subscriber || typeof subscriber !== "object" || Array.isArray(subscriber)) {
    fail(`Subscriber ${index} must be an object.`, 2)
  }
  if (typeof subscriber.connection_id !== "string" || subscriber.connection_id.length === 0) {
    fail(`Subscriber ${index} requires connection_id.`, 2)
  }
  return subscriber
})

const authoritative = subscribers.filter(
  (subscriber) => subscriber.dynamic_tool_handler === true && subscriber.authorized === true,
)
if (authoritative.length !== 1) {
  fail("Dynamic-tool dispatch requires exactly one authorized handler connection.", 64, {
    authorized_handler_count: authoritative.length,
  })
}

const owner = authoritative[0]
const mutating = evidence.mutating === true
if (mutating) {
  for (const field of ["operation_id", "idempotency_key"]) {
    if (typeof evidence[field] !== "string" || evidence[field].trim().length === 0) {
      fail(`Mutating dynamic tools require ${field}.`, 64)
    }
  }
  if (evidence.independent_verification_planned !== true) {
    fail("Mutating dynamic tools require an independent post-write verification plan.", 64)
  }
}

const sideEffect = evidence.durable_side_effect || "none"
if (!new Set(["none", "unknown", "present", "verified"]).has(sideEffect)) {
  fail("durable_side_effect must be none, unknown, present, or verified.", 2)
}

if (evidence.retry_requested === true && (sideEffect === "unknown" || sideEffect === "present")) {
  fail("Retry blocked until the uncertain or present durable side effect is reconciled.", 75, {
    action: "reconcile_before_retry",
  })
}

if (evidence.caller_visible_result === "failure" && (sideEffect === "present" || sideEffect === "verified")) {
  fail("Caller-visible failure conflicts with durable side-effect evidence; treat the operation as an uncertain write.", 75, {
    action: "reconcile_before_retry",
  })
}

if (subscribers.length === 1) {
  if (evidence.exclusive_thread_lease !== true) {
    fail("Single-subscriber compatibility mode requires an attested exclusive thread lease.", 64)
  }
  if (owner.connection_id !== subscribers[0].connection_id) {
    fail("The sole subscriber is not the authorized dynamic-tool handler.", 64)
  }
} else {
  if (evidence.targeted_dispatch !== true) {
    fail("Multi-subscriber dynamic-tool dispatch is blocked unless the request is targeted to one connection.", 75, {
      action: "route_to_single_subscriber_or_patched_app_server",
    })
  }
  if (evidence.target_connection_id !== owner.connection_id) {
    fail("The targeted connection does not match the authorized dynamic-tool handler.", 64)
  }
  if (evidence.callback_bound_to_connection !== true) {
    fail("The pending callback must be bound to both request ID and target connection ID.", 64)
  }
  if (evidence.response_connection_id && evidence.response_connection_id !== owner.connection_id) {
    fail("A non-target connection attempted to resolve the dynamic-tool request.", 64)
  }
  const unauthorizedResponders = subscribers.filter(
    (subscriber) => subscriber.connection_id !== owner.connection_id && subscriber.response_authority !== false,
  )
  if (unauthorizedResponders.length > 0) {
    fail("Every non-target subscriber must explicitly lack dynamic-tool response authority.", 64)
  }
}

const output = {
  admitted: true,
  exit_code: 0,
  thread_id: evidence.thread_id,
  request_id: evidence.request_id,
  tool_name: evidence.tool_name,
  authoritative_connection_id: owner.connection_id,
  subscriber_count: subscribers.length,
  dispatch_mode: subscribers.length === 1 ? "exclusive_single_subscriber" : "targeted_connection_bound",
  mutating,
  reconciliation_required: false,
}

console.log(args.json ? JSON.stringify(output, null, 2) : `Dynamic tool admitted for ${owner.connection_id}`)
