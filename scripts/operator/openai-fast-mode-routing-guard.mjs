import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular non-symlink file`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function number(value, name, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`)
  return parsed
}

function optionalObject(value, name) {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`)
  return value.map((item, index) => nonEmptyString(item, `${name}[${index}]`))
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const approvedRoutes = new Set(["direct_openai_api", "direct_openai_cli", "approved_local_openai"])
const acceptedRequestTiers = new Set(["fast", "priority", "default"])
const fastResponseTiers = new Set(["fast", "priority"])

if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (prohibited.test(JSON.stringify(evidence))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let model
let allowedModels
let request
let response
let pricing
let state
let route

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  model = nonEmptyString(evidence.model, "model").toLowerCase()
  allowedModels = stringArray(evidence.allowed_model_slugs, "allowed_model_slugs").map((value) => value.toLowerCase())
  request = optionalObject(evidence.request, "request")
  response = optionalObject(evidence.response, "response")
  pricing = optionalObject(evidence.pricing, "pricing")
  state = optionalObject(evidence.state, "state")
  route = optionalObject(evidence.route, "route")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (allowedModels.some((value) => prohibited.test(value))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_model_in_allowlist" }, null, 2))
  process.exit(64)
}

const requestedTier = optionalString(request.service_tier, "request.service_tier").toLowerCase() || "default"
const workloadClass = optionalString(request.workload_class, "request.workload_class").toLowerCase()
const latencyCritical = boolean(request.latency_critical, "request.latency_critical")
const expectedTpm = number(request.expected_tpm, "request.expected_tpm")
const priorTpm = number(request.prior_tpm, "request.prior_tpm")
const rampWindowMinutes = number(request.ramp_window_minutes, "request.ramp_window_minutes", 15)

const responseReceived = boolean(response.received, "response.received")
const actualTier = optionalString(response.service_tier, "response.service_tier").toLowerCase()
const usageRecorded = boolean(response.usage_recorded, "response.usage_recorded")
const billingTierRecorded = boolean(response.billing_tier_recorded, "response.billing_tier_recorded")
const downgradeHandled = boolean(response.downgrade_handled, "response.downgrade_handled")

const pricingVerified = boolean(pricing.official_pricing_verified, "pricing.official_pricing_verified")
const premiumAcknowledged = boolean(pricing.fast_premium_acknowledged, "pricing.fast_premium_acknowledged")
const standardInput = number(pricing.standard_input_per_million, "pricing.standard_input_per_million")
const fastInput = number(pricing.fast_input_per_million, "pricing.fast_input_per_million")
const standardOutput = number(pricing.standard_output_per_million, "pricing.standard_output_per_million")
const fastOutput = number(pricing.fast_output_per_million, "pricing.fast_output_per_million")

const taskStatePreserved = boolean(state.task_state_preserved, "state.task_state_preserved")
const externalWritesReconciled = boolean(state.external_writes_reconciled, "state.external_writes_reconciled")
const automaticReplayRequested = boolean(state.automatic_replay_requested, "state.automatic_replay_requested")
const idempotencyKey = nonEmptyString(state.idempotency_key, "state.idempotency_key")

const routeType = optionalString(route.type, "route.type").toLowerCase()
const routeVerified = boolean(route.verified, "route.verified")
const operationBindingMatches = boolean(route.operation_binding_matches, "route.operation_binding_matches")
const exactModelPinned = boolean(route.exact_model_pinned, "route.exact_model_pinned")
const canaryPassed = boolean(route.canary_passed, "route.canary_passed")

const modelAllowed = allowedModels.includes(model)
const tierAccepted = acceptedRequestTiers.has(requestedTier)
const fastRequested = requestedTier === "fast" || requestedTier === "priority"
const batchLike = ["batch", "etl", "bulk", "backfill"].includes(workloadClass)
const growth = priorTpm > 0 ? (expectedTpm - priorTpm) / priorTpm : expectedTpm > 0 ? Infinity : 0
const rampRisk = fastRequested && expectedTpm >= 1_000_000 && growth > 0.5 && rampWindowMinutes <= 15
const priceRelationshipValid =
  !fastRequested ||
  (pricingVerified &&
    premiumAcknowledged &&
    fastInput >= standardInput &&
    fastOutput >= standardOutput &&
    standardInput > 0 &&
    standardOutput > 0)
const routeReady =
  approvedRoutes.has(routeType) &&
  routeVerified &&
  operationBindingMatches &&
  exactModelPinned &&
  canaryPassed &&
  taskStatePreserved &&
  externalWritesReconciled &&
  !automaticReplayRequested

const actualFast = fastResponseTiers.has(actualTier)
const actualDefault = actualTier === "default"
const responseTierRecognized = !responseReceived || actualFast || actualDefault
const responseTelemetryComplete = !responseReceived || (usageRecorded && billingTierRecorded)
const fastAliasNormalized = !fastRequested || requestedTier === "fast" || requestedTier === "priority"

let admitted = true
let reason = "openai_fast_mode_route_verified"
let action = "continue_with_verified_service_tier"
let exitCode = 0

if (!modelAllowed) {
  admitted = false
  reason = "model_not_explicitly_allowed"
  action = "pin_an_explicit_approved_openai_model"
  exitCode = 64
} else if (!tierAccepted || !fastAliasNormalized) {
  admitted = false
  reason = "unsupported_service_tier"
  action = "use_fast_priority_alias_or_default"
  exitCode = 64
} else if (fastRequested && batchLike) {
  admitted = false
  reason = "fast_mode_rejected_for_batch_or_etl_workload"
  action = "route_batch_or_etl_to_standard_or_batch_processing"
  exitCode = 64
} else if (fastRequested && !latencyCritical) {
  admitted = false
  reason = "fast_mode_requires_latency_critical_workload"
  action = "use_standard_processing_or_record_latency_critical_justification"
  exitCode = 64
} else if (fastRequested && !priceRelationshipValid) {
  admitted = false
  reason = "fast_mode_pricing_receipt_missing_or_invalid"
  action = "verify_official_pricing_and_acknowledge_premium"
  exitCode = 64
} else if (rampRisk) {
  admitted = false
  reason = "fast_mode_ramp_rate_risk"
  action = "shift_traffic_gradually_or_keep_excess_on_standard"
  exitCode = 75
} else if (!responseTierRecognized) {
  admitted = false
  reason = "unrecognized_response_service_tier"
  action = "preserve_state_and_verify_openai_response_contract"
  exitCode = 75
} else if (!responseTelemetryComplete) {
  admitted = false
  reason = "response_service_tier_not_bound_to_usage_and_billing"
  action = "record_actual_response_tier_before_declaring_fast_processing"
  exitCode = 75
} else if (fastRequested && responseReceived && actualDefault && !downgradeHandled) {
  admitted = false
  reason = "fast_request_downgraded_without_standard_fallback_handling"
  action = "treat_request_as_standard_and_adjust_latency_capacity"
  exitCode = 75
} else if (automaticReplayRequested) {
  admitted = false
  reason = "automatic_replay_rejected"
  action = "preserve_state_and_continue_only_the_exact_unfinished_action"
  exitCode = 64
} else if (!routeReady) {
  admitted = false
  reason = "approved_route_receipt_incomplete"
  action = "verify_direct_openai_or_approved_local_route"
  exitCode = 75
} else if (fastRequested && responseReceived && actualDefault && downgradeHandled) {
  reason = "fast_request_safely_downgraded_to_standard"
  action = "continue_at_standard_tier_and_update_capacity_forecast"
} else if (fastRequested && responseReceived && actualFast) {
  reason = requestedTier === "fast" && actualTier === "priority"
    ? "fast_alias_verified_with_priority_response_label"
    : "fast_mode_response_verified"
  action = "continue_latency_critical_operation"
}

const result = {
  admitted,
  reason,
  action,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  model,
  requested_service_tier: requestedTier,
  actual_service_tier: actualTier || null,
  ramp_risk: rampRisk,
  workload_class: workloadClass || null,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
