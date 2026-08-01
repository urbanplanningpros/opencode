import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-security-deep-scan-continuity-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-security-scan-guard-"))
const repo = path.join(temp, "repo")
fs.mkdirSync(repo, { recursive: true })
spawnSync("git", ["init", "-q", repo], { check: true })
spawnSync("git", ["-C", repo, "config", "user.email", "operator@example.invalid"], { check: true })
spawnSync("git", ["-C", repo, "config", "user.name", "Operator Selftest"], { check: true })

for (let index = 1; index <= 7; index += 1) {
  const dir = index <= 4 ? "packages/app" : "packages/api"
  fs.mkdirSync(path.join(repo, dir), { recursive: true })
  fs.writeFileSync(path.join(repo, dir, `file-${index}.txt`), "x".repeat(index * 10))
}
spawnSync("git", ["-C", repo, "add", "."], { check: true })
spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { check: true })

const manifest = path.join(temp, "failure.json")
fs.writeFileSync(
  manifest,
  JSON.stringify({
    schemaVersion: 1,
    workflowVersion: "deep-scan-mcp/v1",
    scanId: "scan-original",
    discoveryCount: 0,
    setup: { mode: "deterministic", completed: false },
    status: "failed",
    dispatchedCount: 0,
    failure: { phase: "setup", message: "Invalid string length", kind: "RangeError" },
    canonical: null,
  }),
)

const output = path.join(temp, "plan.json")
const result = spawnSync(
  process.execPath,
  [
    guard,
    "plan",
    "--manifest",
    manifest,
    "--repo",
    repo,
    "--operation-id",
    "op-36452",
    "--output",
    output,
    "--max-files",
    "3",
    "--max-bytes",
    "1000000",
    "--provider",
    "openai",
    "--model",
    "gpt-5.6-sol",
    "--route",
    "authorized-local",
  ],
  { encoding: "utf8" },
)
assert.equal(result.status, 0, result.stderr)
const plan = JSON.parse(fs.readFileSync(output, "utf8"))
assert.equal(plan.status, "fallback_plan_ready")
assert.equal(plan.original_scan.scan_id, "scan-original")
assert.equal(plan.original_scan.retry_original_scan, false)
assert.equal(plan.routing.provider, "openai")
assert.equal(plan.routing.automatic_model_selection, false)
assert.equal(plan.routing.gateway, null)
assert.deepEqual(plan.routing.fallback_chain, [])
assert.equal(plan.chunk_policy.chunk_count, 3)
assert.deepEqual(
  plan.child_scans.map((chunk) => chunk.file_count),
  [3, 3, 1],
)
const scoped = plan.child_scans.flatMap((chunk) => chunk.scope_files)
assert.equal(scoped.length, 7)
assert.equal(new Set(scoped).size, 7)
assert.equal(plan.child_scans.every((chunk) => chunk.must_create_new_scan_id), true)
assert.equal(plan.child_scans.every((chunk) => chunk.must_not_import_original_session), true)

const badProvider = spawnSync(
  process.execPath,
  [guard, "plan", "--manifest", manifest, "--repo", repo, "--operation-id", "bad", "--provider", "other"],
  { encoding: "utf8" },
)
assert.equal(badProvider.status, 78)

const automaticModel = spawnSync(
  process.execPath,
  [guard, "plan", "--manifest", manifest, "--repo", repo, "--operation-id", "bad", "--model", "auto"],
  { encoding: "utf8" },
)
assert.equal(automaticModel.status, 78)

const gateway = spawnSync(
  process.execPath,
  [guard, "plan", "--manifest", manifest, "--repo", repo, "--operation-id", "bad", "--gateway", "configured"],
  { encoding: "utf8" },
)
assert.equal(gateway.status, 78)

const nonMatching = path.join(temp, "nonmatching.json")
fs.writeFileSync(
  nonMatching,
  JSON.stringify({
    scanId: "scan-other",
    setup: { completed: true },
    status: "failed",
    dispatchedCount: 1,
    failure: { phase: "discovery", message: "network timeout", kind: "TimeoutError" },
  }),
)
const noFallback = spawnSync(
  process.execPath,
  [guard, "plan", "--manifest", nonMatching, "--repo", repo, "--operation-id", "other"],
  { encoding: "utf8" },
)
assert.equal(noFallback.status, 3)
const noFallbackBody = JSON.parse(noFallback.stdout)
assert.equal(noFallbackBody.status, "no_guarded_fallback_needed")

console.log("codex-security-deep-scan-continuity-guard: 18 checks passed")
