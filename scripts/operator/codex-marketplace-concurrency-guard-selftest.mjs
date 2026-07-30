#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-marketplace-concurrency-"))
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-marketplace-concurrency-guard.mjs")

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

const base = {
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  operation: { id: "op-market-1", idempotency_key: "idem-market-1", parallel_exec_processes: 4 },
  marketplace: {
    id: "compound-engineering-plugin",
    source_type: "git",
    source: "https://github.com/EveryInc/compound-engineering-plugin.git",
    ref: "main",
    stored_revision: "abc123",
    remote_revision: "abc123",
    lightweight_ref_check_completed: true,
    cross_process_lock_held: true,
    unchanged_revision_reused: true,
    refresh_needed: false,
    concurrent_clone_processes: 0,
    active_https_connections: 0,
    staging_directories: 0,
    staging_bytes: 0,
    orphan_clone_processes: 0,
    orphan_processes_inventoried: true,
    cleanup_scoped_to_verified_pids: true,
    bulk_process_kill_requested: false,
  },
  containment: {
    new_exec_launches_suspended: false,
    marketplace_refresh_isolated: false,
    pinned_materialization_verified: true,
    unaffected_workflows_continued: true,
  },
}

try {
  run("healthy-single-flight", base, 0, "compatible")

  const noLock = structuredClone(base)
  noLock.marketplace.cross_process_lock_held = false
  const noLockResult = run("missing-lock", noLock, 75, "remediation_required")
  if (!noLockResult.remediation.includes("acquire_per_marketplace_cross_process_lock")) {
    throw new Error("missing-lock: expected lock remediation")
  }

  const fanout = structuredClone(base)
  fanout.marketplace.concurrent_clone_processes = 50
  fanout.marketplace.active_https_connections = 47
  fanout.marketplace.staging_directories = 100
  fanout.marketplace.staging_bytes = 4_300_000_000
  fanout.marketplace.orphan_clone_processes = 12
  fanout.marketplace.orphan_processes_inventoried = false
  fanout.marketplace.cleanup_scoped_to_verified_pids = false
  fanout.containment.new_exec_launches_suspended = true
  fanout.containment.marketplace_refresh_isolated = true
  const fanoutResult = run("clone-fanout", fanout, 64, "blocked")
  for (const reason of [
    "duplicate_marketplace_clone_fanout_detected",
    "marketplace_staging_resource_pressure_detected",
    "marketplace_https_connection_fanout_detected",
    "orphan_clone_process_inventory_required",
    "orphan_clone_cleanup_must_be_pid_scoped",
  ]) {
    if (!fanoutResult.blocked.includes(reason)) throw new Error(`clone-fanout: missing ${reason}`)
  }

  const unchangedClone = structuredClone(base)
  unchangedClone.marketplace.unchanged_revision_reused = false
  const unchangedResult = run("unchanged-revision-cloned", unchangedClone, 75, "remediation_required")
  if (!unchangedResult.remediation.includes("reuse_existing_marketplace_materialization")) {
    throw new Error("unchanged-revision-cloned: expected reuse remediation")
  }

  const bulkKill = structuredClone(base)
  bulkKill.marketplace.bulk_process_kill_requested = true
  const bulkKillResult = run("bulk-kill", bulkKill, 64, "blocked")
  if (!bulkKillResult.blocked.includes("bulk_process_kill_forbidden")) {
    throw new Error("bulk-kill: expected bulk kill rejection")
  }

  const prohibitedRoute = structuredClone(base)
  prohibitedRoute.routing = { provider: "anthropic", route: "gateway", automatic_selector: true, model_gateway: true }
  run("prohibited-route", prohibitedRoute, 64, "blocked")

  console.log("Codex marketplace concurrency guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
