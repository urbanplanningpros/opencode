import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "codex-subagent-resume-quota-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-resume-quota-guard-"))
const manifest = path.join(temp, "manifest.json")

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, `unexpected status\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  return result
}

run([
  "register",
  "--operation-id",
  "op-1",
  "--child-id",
  "child-1",
  "--model",
  "gpt-5.6-luna",
  "--reasoning-effort",
  "medium",
  "--output",
  manifest,
])

const plan = JSON.parse(run(["plan-resume", "--manifest", manifest]).stdout)
assert.equal(plan.route.model, "gpt-5.6-luna")
assert.equal(plan.route.provider, "openai")
assert.equal(plan.cli_argv.includes("gpt-5.6-luna"), true)

run(["plan-resume", "--manifest", manifest, "--native-resume-agent", "true"], 2)

const goodReceipt = path.join(temp, "good-receipt.json")
fs.writeFileSync(
  goodReceipt,
  JSON.stringify({
    operation_id: "op-1",
    child_id: "child-1",
    provider: "openai",
    effective_model: "gpt-5.6-luna",
    effective_reasoning_effort: "medium",
  }),
)
run(["verify-effective", "--manifest", manifest, "--receipt", goodReceipt])

const badReceipt = path.join(temp, "bad-receipt.json")
fs.writeFileSync(
  badReceipt,
  JSON.stringify({
    operation_id: "op-1",
    child_id: "child-1",
    provider: "openai",
    effective_model: "gpt-5.6-sol",
    effective_reasoning_effort: "medium",
  }),
)
run(["verify-effective", "--manifest", manifest, "--receipt", badReceipt], 2)

const previous = path.join(temp, "quota-before.json")
const current = path.join(temp, "quota-after.json")
const audit = path.join(temp, "quota-audit.json")
fs.writeFileSync(previous, JSON.stringify({ used_percent: 32, resets_at: 2000 }))
fs.writeFileSync(current, JSON.stringify({ used_percent: 0, resets_at: 3000, observed_at_epoch: 1500 }))
run(["audit-quota", "--previous", previous, "--current", current, "--output", audit], 3)
assert.equal(JSON.parse(fs.readFileSync(audit, "utf8")).status, "unexpected_reset_requires_reconciliation")

fs.writeFileSync(current, JSON.stringify({ used_percent: 0, resets_at: 3000, observed_at_epoch: 2500 }))
run(["audit-quota", "--previous", previous, "--current", current, "--output", audit])
assert.equal(JSON.parse(fs.readFileSync(audit, "utf8")).status, "ok")

console.log("codex-subagent-resume-quota-guard self-test passed")
