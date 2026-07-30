import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./openai-fast-mode-routing-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openai-fast-mode-routing-"))

const base = {
  operation_id: "op-fast-1",
  model: "gpt-5.6-sol",
  allowed_model_slugs: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  request: {
    service_tier: "fast",
    workload_class: "interactive",
    latency_critical: true,
    expected_tpm: 400000,
    prior_tpm: 300000,
    ramp_window_minutes: 15,
  },
  response: {
    received: true,
    service_tier: "priority",
    usage_recorded: true,
    billing_tier_recorded: true,
    downgrade_handled: false,
  },
  pricing: {
    official_pricing_verified: true,
    fast_premium_acknowledged: true,
    standard_input_per_million: 2.5,
    fast_input_per_million: 5,
    standard_output_per_million: 15,
    fast_output_per_million: 30,
  },
  state: {
    idempotency_key: "idem-fast-1",
    task_state_preserved: true,
    external_writes_reconciled: true,
    automatic_replay_requested: false,
  },
  route: {
    type: "direct_openai_api",
    verified: true,
    operation_binding_matches: true,
    exact_model_pinned: true,
    canary_passed: true,
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("fast-priority-response-alias", structuredClone(base), 0, "fast_alias_verified_with_priority_response_label")

const priorityAlias = structuredClone(base)
priorityAlias.request.service_tier = "priority"
run("priority-request-alias", priorityAlias, 0, "fast_mode_response_verified")

const standard = structuredClone(base)
standard.request.service_tier = "default"
standard.request.latency_critical = false
standard.response.service_tier = "default"
standard.response.downgrade_handled = true
run("standard-route", standard, 0, "openai_fast_mode_route_verified")

const batch = structuredClone(base)
batch.request.workload_class = "etl"
run("batch-rejected", batch, 64, "fast_mode_rejected_for_batch_or_etl_workload")

const noLatency = structuredClone(base)
noLatency.request.latency_critical = false
run("non-latency-critical-rejected", noLatency, 64, "fast_mode_requires_latency_critical_workload")

const ramp = structuredClone(base)
ramp.request.expected_tpm = 1600000
ramp.request.prior_tpm = 900000
run("ramp-risk", ramp, 75, "fast_mode_ramp_rate_risk")

const noPricing = structuredClone(base)
noPricing.pricing.official_pricing_verified = false
run("pricing-receipt-required", noPricing, 64, "fast_mode_pricing_receipt_missing_or_invalid")

const downgrade = structuredClone(base)
downgrade.response.service_tier = "default"
run("unhandled-downgrade", downgrade, 75, "fast_request_downgraded_without_standard_fallback_handling")

const handledDowngrade = structuredClone(downgrade)
handledDowngrade.response.downgrade_handled = true
run("handled-downgrade", handledDowngrade, 0, "fast_request_safely_downgraded_to_standard")

const prohibited = structuredClone(base)
prohibited.route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
