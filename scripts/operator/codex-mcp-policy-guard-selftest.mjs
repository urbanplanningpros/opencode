import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-mcp-policy-guard.mjs")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-policy-guard-"))

function run(name, evidence, expectedStatus, expectedReason) {
  const input = path.join(temporary, `${name}.json`)
  fs.writeFileSync(input, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`)
  const report = JSON.parse(result.stdout || result.stderr)
  assert.equal(report.status, expectedReason)
  return report
}

const base = {
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
}

run("safe", base, 0, "compatible")

const bounded = {
  ...base,
  mcp_catalog_pagination: {
    page_count: 3,
    item_count: 90,
    maximum_cursor_bytes_observed: 128,
    repeated_cursor_observed: false,
    overall_timeout_seconds: 30,
    limits_enforced: true,
    upstream_fix_in_pinned_stable: false,
  },
}
const boundedReport = run("bounded", bounded, 0, "compatible")
assert.ok(boundedReport.warnings.includes("upstream_mcp_pagination_fix_not_in_pinned_stable"))

const unbounded = structuredClone(bounded)
unbounded.mcp_catalog_pagination.limits_enforced = false
run("unbounded", unbounded, 75, "remediation_required")

const repeated = structuredClone(bounded)
repeated.mcp_catalog_pagination.repeated_cursor_observed = true
run("repeated", repeated, 64, "blocked")

const oversized = structuredClone(bounded)
oversized.mcp_catalog_pagination.item_count = 1_025
run("oversized", oversized, 64, "blocked")

const unknownAuthSafe = {
  ...base,
  mcp_authentication: {
    status: "unknown",
    discovery_error_class: "rate_limited",
    retry_count: 1,
    same_server_and_endpoint_preserved: true,
    anonymous_fallback_selected: false,
    upstream_fix_in_pinned_stable: false,
  },
}
const unknownAuthReport = run("unknown-auth-safe", unknownAuthSafe, 0, "compatible")
assert.ok(unknownAuthReport.warnings.includes("upstream_mcp_unknown_auth_fix_not_in_pinned_stable"))

const unknownAuthAnonymous = structuredClone(unknownAuthSafe)
unknownAuthAnonymous.mcp_authentication.anonymous_fallback_selected = true
run("unknown-auth-anonymous", unknownAuthAnonymous, 64, "blocked")

const transientMisclassified = structuredClone(unknownAuthSafe)
transientMisclassified.mcp_authentication.status = "unsupported"
run("transient-auth-misclassified", transientMisclassified, 64, "blocked")

const authRetryLoop = structuredClone(unknownAuthSafe)
authRetryLoop.mcp_authentication.retry_count = 2
run("auth-retry-loop", authRetryLoop, 64, "blocked")

const failedSafe = {
  ...base,
  network_policy_amendment: {
    requested: true,
    requested_host: "api.approved.example",
    amendment_host: "not-the-approved-host.invalid",
    action: "allow",
    applied: false,
    pending_request_outcome: "deny",
    session_host_approved: false,
    owning_call_outcome: "denied_by_policy",
  },
}
run("failed-safe", failedSafe, 0, "compatible")

const failedUnsafe = structuredClone(failedSafe)
failedUnsafe.network_policy_amendment.pending_request_outcome = "allow_for_session"
failedUnsafe.network_policy_amendment.session_host_approved = true
run("failed-unsafe", failedUnsafe, 64, "blocked")

const failedUnrecorded = structuredClone(failedSafe)
failedUnrecorded.network_policy_amendment.pending_request_outcome = ""
failedUnrecorded.network_policy_amendment.owning_call_outcome = ""
run("failed-unrecorded", failedUnrecorded, 75, "remediation_required")

const githubFallbackSafe = {
  ...base,
  github_connector_write: {
    requested: true,
    model: "gpt-5.6-sol",
    connector_authenticated: true,
    repository_write_access_verified: true,
    capability_claim: "unavailable",
    capability_canary_passed: false,
    mutation_state: "not_dispatched",
    operation_id: "op-123",
    idempotency_key: "idem-123",
    continuation_route: "direct-openai-pinned-gpt-5.5",
    write_receipt_verified: false,
  },
}
const githubFallbackReport = run("github-fallback-safe", githubFallbackSafe, 75, "remediation_required")
assert.ok(githubFallbackReport.warnings.includes("gpt_5_6_github_connector_capability_regression_possible"))
assert.ok(githubFallbackReport.remediation.includes("withhold_gpt_5_6_github_write_authority"))

const githubUnsafeReplay = structuredClone(githubFallbackSafe)
githubUnsafeReplay.github_connector_write.mutation_state = "unknown"
run("github-unsafe-replay", githubUnsafeReplay, 64, "blocked")

const githubNoFallback = structuredClone(githubFallbackSafe)
githubNoFallback.github_connector_write.continuation_route = ""
run("github-no-fallback", githubNoFallback, 75, "remediation_required")

const githubWriteReceipt = {
  ...base,
  github_connector_write: {
    requested: true,
    model: "gpt-5.5",
    connector_authenticated: true,
    repository_write_access_verified: true,
    capability_claim: "available",
    capability_canary_passed: true,
    mutation_state: "completed",
    operation_id: "op-456",
    idempotency_key: "idem-456",
    continuation_route: "direct-openai-pinned-gpt-5.5",
    write_receipt_verified: true,
    branch_name: "codex/fix-example",
    final_head_sha: "de9e97f83856e07b147154da4e52135ec604e840",
  },
}
run("github-write-receipt", githubWriteReceipt, 0, "compatible")

const prohibited = {
  routing: { provider: "openai", route: "automatic model gateway", automatic_selector: true },
}
run("prohibited", prohibited, 64, "blocked")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("Codex MCP policy guard self-test passed")
