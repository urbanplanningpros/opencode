#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-external-write-target-"))
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-external-write-target-guard.mjs")
const hash = "a".repeat(64)

function run(name, evidence, expectedExit, expectedStatus) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedExit) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${name}: expected exit ${expectedExit}, got ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedStatus) throw new Error(`${name}: expected ${expectedStatus}, got ${output.status}`)
  return output
}

const now = Date.now()
const base = {
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  operation: {
    id: "op-123",
    idempotency_key: "idem-123",
    class: "write",
    authorized_mutations: ["upload_files"],
    requested_mutations: ["upload_files"],
  },
  target: {
    configured_target_id: "figshare:item:123:revision:2",
    observed_target_id: "figshare:item:123:revision:2",
    canonical_endpoint: "https://api.figshare.com/v2/account/articles/123",
    parent_state: "published",
    revision_state: "unpublished",
    approved_target_state_sha256: hash,
    observed_target_state_sha256: hash,
    preflight_observed_at: new Date(now - 5_000).toISOString(),
    write_dispatched_at: new Date(now).toISOString(),
    preflight_max_age_seconds: 60,
    description_assumed_without_authoritative_read: false,
    write_dispatched_before_state_preflight: false,
  },
  attempt: { status: "completed", durable_state_reconciled: true, post_write_verified: true, retry_requested: false },
}

try {
  run("healthy-published-parent-unpublished-revision", base, 0, "compatible")

  const assumed = structuredClone(base)
  assumed.target.description_assumed_without_authoritative_read = true
  const assumedResult = run("assumed-target-state", assumed, 64, "blocked")
  if (!assumedResult.blocked.includes("user_description_cannot_replace_target_state_preflight")) {
    throw new Error("assumed-target-state: unsafe assumption was not blocked")
  }

  const changed = structuredClone(base)
  changed.target.observed_target_state_sha256 = "b".repeat(64)
  const changedResult = run("target-changed", changed, 64, "blocked")
  if (!changedResult.blocked.includes("external_target_state_changed_after_approval")) {
    throw new Error("target-changed: state drift was not blocked")
  }

  const unauthorized = structuredClone(base)
  unauthorized.operation.requested_mutations.push("publish")
  const unauthorizedResult = run("unauthorized-publish", unauthorized, 64, "blocked")
  if (!unauthorizedResult.blocked.includes("unauthorized_mutation:publish")) {
    throw new Error("unauthorized-publish: unauthorized mutation was not blocked")
  }

  const uncertain = structuredClone(base)
  uncertain.attempt = { status: "unknown", durable_state_reconciled: false, retry_requested: true }
  const uncertainResult = run("uncertain-write", uncertain, 64, "blocked")
  if (!uncertainResult.blocked.includes("external_write_side_effect_unknown_reconciliation_required")) {
    throw new Error("uncertain-write: unreconciled side effect was not blocked")
  }

  const stale = structuredClone(base)
  stale.target.preflight_observed_at = new Date(now - 120_000).toISOString()
  const staleResult = run("stale-preflight", stale, 75, "remediation_required")
  if (!staleResult.remediation.includes("refresh_stale_target_state_before_write")) {
    throw new Error("stale-preflight: stale state did not require refresh")
  }

  const prohibited = structuredClone(base)
  prohibited.routing = { provider: "anthropic", route: "gateway", automatic_selector: true, model_gateway: true }
  run("prohibited-route", prohibited, 64, "blocked")

  console.log("Codex external-write target guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
