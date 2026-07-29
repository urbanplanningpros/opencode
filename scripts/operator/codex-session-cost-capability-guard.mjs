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
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function emit(report, code, jsonMode) {
  const output = JSON.stringify(report, null, 2)
  if (code === 0 || jsonMode) console.log(output)
  else console.error(output)
  process.exit(code)
}

function finiteNumber(value, name, { minimum = 0, integer = false } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${minimum}`)
  }
  return number
}

function validIsoTimestamp(value) {
  if (!value) return false
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed)
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node codex-session-cost-capability-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  emit({ admitted: false, reason: "invalid_input", detail: error.message }, 2, args.json)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const routingMetadata = JSON.stringify({
  provider: evidence.provider,
  route: evidence.route,
  gateway: evidence.gateway,
  fallback: evidence.fallback,
  imported_from: evidence.imported_from,
  proxy_provider: evidence.proxy_provider,
  model_selector: evidence.model_selector,
})
if (prohibited.test(routingMetadata)) {
  emit({ admitted: false, reason: "prohibited_route_metadata" }, 64, args.json)
}

const mode = String(evidence.mode || "")

if (mode === "session_resume_cost") {
  if (!evidence.operation_id || !evidence.selected_model) {
    emit(
      {
        admitted: false,
        reason: "missing_session_identity",
        missing: ["operation_id", "selected_model"].filter((key) => !evidence[key]),
      },
      2,
      args.json,
    )
  }

  let contextTokens
  let idleSeconds
  let contextThreshold
  let cacheStaleSeconds
  let longContextThreshold
  let inputUsdPerMillion = null
  try {
    contextTokens = finiteNumber(evidence.context_tokens, "context_tokens", { integer: true })
    idleSeconds = finiteNumber(evidence.idle_seconds, "idle_seconds", { integer: true })
    contextThreshold = finiteNumber(evidence.resume_context_threshold_tokens ?? 131072, "resume_context_threshold_tokens", {
      minimum: 1,
      integer: true,
    })
    cacheStaleSeconds = finiteNumber(evidence.cache_stale_after_seconds ?? 300, "cache_stale_after_seconds", {
      minimum: 1,
      integer: true,
    })
    longContextThreshold = finiteNumber(evidence.long_context_threshold_tokens ?? 272000, "long_context_threshold_tokens", {
      minimum: 1,
      integer: true,
    })
    if (evidence.input_usd_per_million !== undefined) {
      inputUsdPerMillion = finiteNumber(evidence.input_usd_per_million, "input_usd_per_million")
    }
  } catch (error) {
    emit({ admitted: false, reason: "invalid_session_metrics", detail: error.message }, 2, args.json)
  }

  const cacheState = String(evidence.cache_state || "unknown").toLowerCase()
  if (!new Set(["hot", "cold", "unknown"]).has(cacheState)) {
    emit({ admitted: false, reason: "invalid_cache_state", cache_state: cacheState }, 2, args.json)
  }

  const largeContext = contextTokens >= contextThreshold
  const longContext = contextTokens > longContextThreshold
  const cacheLikelyCold = cacheState !== "hot" || idleSeconds >= cacheStaleSeconds
  const estimatedUncachedResumeUsd =
    inputUsdPerMillion === null ? null : Number(((contextTokens / 1_000_000) * inputUsdPerMillion).toFixed(6))

  const metrics = {
    context_tokens: contextTokens,
    idle_seconds: idleSeconds,
    cache_state: cacheState,
    large_context: largeContext,
    long_context_pricing_boundary_crossed: longContext,
    cache_likely_cold: cacheLikelyCold,
    estimated_uncached_resume_usd: estimatedUncachedResumeUsd,
  }

  if (!largeContext || !cacheLikelyCold) {
    emit(
      {
        admitted: true,
        reason: "resume_cost_within_guardrail",
        operation_id: evidence.operation_id,
        selected_model: evidence.selected_model,
        metrics,
        protocol: "Continue the current session while recording cached and uncached input usage after the next request.",
      },
      0,
      args.json,
    )
  }

  if (evidence.task_state_checkpointed !== true || evidence.pending_writes_reconciled !== true) {
    emit(
      {
        admitted: false,
        reason: "checkpoint_required_before_expensive_resume",
        operation_id: evidence.operation_id,
        selected_model: evidence.selected_model,
        metrics,
        action: "checkpoint_and_reconcile",
        protocol:
          "Persist the task manifest, concise continuation summary, operation ID, idempotency keys, and current diff. Reconcile every uncertain external write before leaving or replaying the session.",
      },
      75,
      args.json,
    )
  }

  const strategy = String(evidence.resume_strategy || "")
  if (!new Set(["fresh_guarded_turn", "approved_local_continuity", "same_session_acknowledged"]).has(strategy)) {
    emit(
      {
        admitted: false,
        reason: "bounded_resume_strategy_required",
        operation_id: evidence.operation_id,
        metrics,
        allowed_strategies: ["fresh_guarded_turn", "approved_local_continuity", "same_session_acknowledged"],
        recommended_action: "fresh_guarded_turn",
        protocol:
          "Start a fresh guarded direct-OpenAI turn from the persisted checkpoint, or use the explicitly authorized local continuity route. Do not invoke a gateway or automatic model selector.",
      },
      75,
      args.json,
    )
  }

  if (strategy === "same_session_acknowledged" && evidence.uncached_resume_cost_acknowledged !== true) {
    emit(
      {
        admitted: false,
        reason: "explicit_uncached_cost_acknowledgement_required",
        operation_id: evidence.operation_id,
        metrics,
        action: "choose_fresh_turn_or_acknowledge_cost",
      },
      75,
      args.json,
    )
  }

  emit(
    {
      admitted: true,
      reason: "bounded_resume_route_verified",
      operation_id: evidence.operation_id,
      selected_model: evidence.selected_model,
      metrics,
      action: strategy,
      protocol:
        strategy === "same_session_acknowledged"
          ? "Resume once with the explicitly selected approved model, record cached_tokens and cache_write_tokens, and stop if the resulting usage exceeds the task budget."
          : "Continue from the persisted checkpoint through the selected approved route while preserving operation identity and independently verifying subsequent writes.",
    },
    0,
    args.json,
  )
}

if (mode === "auth_capability") {
  const required = ["auth_profile", "authoritative_plan", "feature"]
  const missing = required.filter((key) => !evidence[key])
  if (missing.length > 0) {
    emit({ admitted: false, reason: "missing_auth_capability_evidence", missing }, 2, args.json)
  }

  const authoritativePlan = String(evidence.authoritative_plan).toLowerCase()
  const cachedPlan = String(evidence.cached_plan || "unknown").toLowerCase()
  const feature = String(evidence.feature)
  const featureRegistered = evidence.feature_registered === true
  const cacheTimestampValid = validIsoTimestamp(evidence.cached_subscription_checked_at)
  const stateConsistent = cachedPlan === authoritativePlan && featureRegistered && cacheTimestampValid

  if (stateConsistent) {
    emit(
      {
        admitted: true,
        reason: "auth_capability_state_consistent",
        auth_profile: evidence.auth_profile,
        authoritative_plan: authoritativePlan,
        feature,
        action: "continue_new_or_existing_guarded_session",
      },
      0,
      args.json,
    )
  }

  const refreshed =
    evidence.reauth_completed === true &&
    evidence.fresh_session_started === true &&
    String(evidence.post_refresh_cached_plan || "").toLowerCase() === authoritativePlan &&
    evidence.post_refresh_feature_registered === true &&
    validIsoTimestamp(evidence.post_refresh_checked_at)

  if (refreshed) {
    emit(
      {
        admitted: true,
        reason: "auth_capability_refreshed",
        auth_profile: evidence.auth_profile,
        authoritative_plan: authoritativePlan,
        previous_cached_plan: cachedPlan,
        feature,
        action: "continue_fresh_guarded_session",
        protocol:
          "Keep this authentication profile isolated. Do not copy auth, plugin, MCP, or session state into another CODEX_HOME.",
      },
      0,
      args.json,
    )
  }

  emit(
    {
      admitted: false,
      reason: "stale_or_inconsistent_auth_capability_state",
      auth_profile: evidence.auth_profile,
      authoritative_plan: authoritativePlan,
      cached_plan: cachedPlan,
      cached_subscription_timestamp_valid: cacheTimestampValid,
      feature,
      feature_registered: featureRegistered,
      action: "reauthenticate_dedicated_profile_then_start_fresh_session",
      protocol:
        "Withhold only the missing hosted capability. Preserve the current task state, run the normal OpenAI browser login for the dedicated CODEX_HOME, start a brand-new guarded session, and recapture the effective feature list. Do not delete auth files, edit claims, copy tokens, or route through another provider.",
    },
    75,
    args.json,
  )
}

if (mode === "extension_gate_health") {
  const providerReady = evidence.provider_ready === true
  const refreshSuccess = evidence.refresh_success === true
  const hasValues = evidence.has_values === true
  const networkError = String(evidence.network_error || "")

  if (hasValues && providerReady) {
    emit(
      {
        admitted: true,
        reason: "extension_gate_values_loaded",
        action: "continue_extension_session",
      },
      0,
      args.json,
    )
  }

  emit(
    {
      admitted: false,
      reason: providerReady && refreshSuccess ? "false_ready_without_gate_values" : "extension_gate_initialization_failed",
      provider_ready: providerReady,
      refresh_success: refreshSuccess,
      has_values: hasValues,
      network_error: networkError || null,
      action: "route_capability_dependent_work_to_guarded_cli_or_vps",
      protocol:
        "Treat the extension as degraded even if its provider reports Ready. Do not patch individual feature gates or introduce an unapproved proxy. Preserve the task manifest and continue through the guarded direct-OpenAI CLI/VPS route or an explicitly authorized local route.",
    },
    75,
    args.json,
  )
}

emit({ admitted: false, reason: "unsupported_mode", mode }, 2, args.json)
