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

const prohibited = {
  routing: { provider: "openai", route: "automatic model gateway", automatic_selector: true },
}
run("prohibited", prohibited, 64, "blocked")

fs.rmSync(temporary, { recursive: true, force: true })
console.log("Codex MCP policy guard self-test passed")
