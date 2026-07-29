import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-cost-capability-"))
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-session-cost-capability-guard.mjs")

function run(name, evidence, expectedStatus, expectedReason) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [script, "--input", input, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.reason, expectedReason, `${name}: ${JSON.stringify(report)}`)
  return report
}

run(
  "small-hot-session",
  {
    mode: "session_resume_cost",
    operation_id: "op-1",
    selected_model: "gpt-5.6-luna",
    route: "direct_openai",
    context_tokens: 64000,
    idle_seconds: 60,
    cache_state: "hot",
  },
  0,
  "resume_cost_within_guardrail",
)

run(
  "large-cold-needs-checkpoint",
  {
    mode: "session_resume_cost",
    operation_id: "op-2",
    selected_model: "gpt-5.6-luna",
    route: "direct_openai",
    context_tokens: 250000,
    idle_seconds: 2400,
    cache_state: "unknown",
    input_usd_per_million: 1,
  },
  75,
  "checkpoint_required_before_expensive_resume",
)

const bounded = run(
  "large-cold-fresh-turn",
  {
    mode: "session_resume_cost",
    operation_id: "op-3",
    selected_model: "gpt-5.6-luna",
    route: "direct_openai",
    context_tokens: 300000,
    idle_seconds: 1200,
    cache_state: "cold",
    input_usd_per_million: 1,
    task_state_checkpointed: true,
    pending_writes_reconciled: true,
    resume_strategy: "fresh_guarded_turn",
  },
  0,
  "bounded_resume_route_verified",
)
assert.equal(bounded.metrics.long_context_pricing_boundary_crossed, true)

run(
  "stale-plan",
  {
    mode: "auth_capability",
    provider: "openai",
    route: "direct_openai",
    auth_profile: "openai-business-primary",
    authoritative_plan: "pro",
    cached_plan: "free",
    cached_subscription_checked_at: "2026-05-08T00:00:00Z",
    feature: "image_generation",
    feature_registered: false,
  },
  75,
  "stale_or_inconsistent_auth_capability_state",
)

run(
  "refreshed-plan",
  {
    mode: "auth_capability",
    provider: "openai",
    route: "direct_openai",
    auth_profile: "openai-business-primary",
    authoritative_plan: "pro",
    cached_plan: "free",
    cached_subscription_checked_at: "2026-05-08T00:00:00Z",
    feature: "image_generation",
    feature_registered: false,
    reauth_completed: true,
    fresh_session_started: true,
    post_refresh_cached_plan: "pro",
    post_refresh_feature_registered: true,
    post_refresh_checked_at: "2026-07-29T09:30:00Z",
  },
  0,
  "auth_capability_refreshed",
)

run(
  "false-ready-extension",
  {
    mode: "extension_gate_health",
    provider: "openai",
    route: "direct_openai",
    provider_ready: true,
    refresh_success: true,
    has_values: false,
    network_error: "TypeError: fetch failed",
  },
  75,
  "false_ready_without_gate_values",
)

run(
  "prohibited-route",
  {
    mode: "session_resume_cost",
    operation_id: "op-4",
    selected_model: "gpt-5.6-luna",
    route: "automatic gateway selector",
    context_tokens: 10,
    idle_seconds: 0,
    cache_state: "hot",
  },
  64,
  "prohibited_route_metadata",
)

console.log("codex-session-cost-capability guard self-test passed")
