import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const checkpointGuard = path.join(here, "codex-windows-checkpoint-ref-guard.mjs")
const approvalGuard = path.join(here, "codex-mcp-approval-display-guard.mjs")
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-control-plane-"))

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", shell: false, ...options })
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function payloadHash(evidence) {
  const payload = canonical({
    operation_id: evidence.operation_id,
    idempotency_key: evidence.idempotency_key,
    target: evidence.target,
    risk: evidence.risk,
    exact_operation: evidence.exact_operation,
    source_message: evidence.source_message,
    arguments: evidence.arguments ?? null,
  })
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

try {
  const repo = path.join(fixture, "repo")
  fs.mkdirSync(repo)
  expect(run("git", ["init", repo]).status === 0, "git init failed")
  expect(run("git", ["-C", repo, "config", "user.name", "Operator Test"]).status === 0, "git user.name failed")
  expect(run("git", ["-C", repo, "config", "user.email", "operator-test@example.invalid"]).status === 0, "git user.email failed")
  expect(run("git", ["-C", repo, "commit", "--allow-empty", "-m", "fixture"]).status === 0, "fixture commit failed")

  const hashA = "a".repeat(64)
  const hashB = "b".repeat(64)
  const ref = `refs/codex/turn-diffs/checkpoints/${hashA}/${hashB}/20260729T074000Z/12345678-1234-1234-1234-123456789012`
  expect(run("git", ["-C", repo, "update-ref", ref, "HEAD"]).status === 0, "long checkpoint ref creation failed")

  const blocked = run(process.execPath, [checkpointGuard, "--repo", repo, "--max-path-chars", "180"])
  expect(blocked.status === 75, `expected checkpoint guard exit 75, received ${blocked.status}: ${blocked.stderr}`)
  const blockedReport = JSON.parse(blocked.stdout)
  expect(blockedReport.affected_loose_ref_count === 1, "expected one affected loose ref")

  expect(run("git", ["-C", repo, "pack-refs", "--all", "--prune"]).status === 0, "pack-refs failed")
  const admitted = run(process.execPath, [checkpointGuard, "--repo", repo, "--max-path-chars", "180"])
  expect(admitted.status === 0, `expected checkpoint guard exit 0 after packing, received ${admitted.status}`)

  const approvalFile = path.join(fixture, "approval.json")
  const evidence = {
    operation_id: "op-approval-1",
    idempotency_key: "idem-approval-1",
    target: "staging database",
    risk: "medium",
    exact_operation: "SELECT id FROM logs LIMIT 1",
    source_message: "Protected operation requires approval\n\nAsset: staging database\nRisk: medium\n\nSQL:\nSELECT id FROM logs LIMIT 1",
    rendered_message: "Protected operation requires approval Asset: staging database Risk: medium SQL: SELECT id FROM logs LIMIT 1",
    arguments: { sql: "SELECT id FROM logs LIMIT 1" },
    write_intent: true,
    route: "openai-direct",
  }
  evidence.approval_receipt = {
    approved: true,
    operation_id: evidence.operation_id,
    idempotency_key: evidence.idempotency_key,
    target: evidence.target,
    exact_operation: evidence.exact_operation,
    payload_sha256: payloadHash(evidence),
  }
  fs.writeFileSync(approvalFile, `${JSON.stringify(evidence, null, 2)}\n`)

  const collapsed = run(process.execPath, [approvalGuard, "--input", approvalFile, "--json"])
  expect(collapsed.status === 75, `expected collapsed display exit 75, received ${collapsed.status}`)

  evidence.out_of_band_preview_verified = true
  fs.writeFileSync(approvalFile, `${JSON.stringify(evidence, null, 2)}\n`)
  const independentlyApproved = run(process.execPath, [approvalGuard, "--input", approvalFile, "--json"])
  expect(independentlyApproved.status === 0, `expected independent approval exit 0, received ${independentlyApproved.status}: ${independentlyApproved.stderr}`)

  evidence.approval_receipt.payload_sha256 = "0".repeat(64)
  fs.writeFileSync(approvalFile, `${JSON.stringify(evidence, null, 2)}\n`)
  const mismatched = run(process.execPath, [approvalGuard, "--input", approvalFile, "--json"])
  expect(mismatched.status === 64, `expected receipt mismatch exit 64, received ${mismatched.status}`)

  console.log("Windows checkpoint and MCP approval guards passed deterministic self-tests")
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
