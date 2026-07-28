import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-budget-guard-"))
const script = path.resolve("scripts/operator/codex-skill-catalog-budget-guard.mjs")

function run(name, evidence) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  const result = spawnSync(process.execPath, [script, "--input", input, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    body: result.stdout ? JSON.parse(result.stdout) : null,
  }
}

const base = {
  schema_version: 1,
  runtime: "codex",
  catalog_source: "selftest",
  write_authority_requested: true,
  required_skills: ["operator-continuity", "github-review"],
  visible_host_skills: ["operator-continuity"],
  visible_executor_skills: ["github-review"],
  warnings: [],
}

const healthy = run("healthy", base)
assert.equal(healthy.status, 0)
assert.equal(healthy.body.status, "verified")
assert.equal(healthy.body.safe_for_external_writes, true)

const missing = run("missing", {
  ...base,
  visible_executor_skills: [],
})
assert.equal(missing.status, 75)
assert.deepEqual(missing.body.missing_required_skills, ["github-review"])
assert.equal(missing.body.safe_for_external_writes, false)

const pressuredWrite = run("pressured-write", {
  ...base,
  warnings: [
    "Host skills are available but omitted from the model-visible skills list because the skills context budget was exceeded.",
  ],
})
assert.equal(pressuredWrite.status, 75)
assert.equal(pressuredWrite.body.budget_pressure, true)

const pressuredRead = run("pressured-read", {
  ...base,
  write_authority_requested: false,
  warnings: ["Exceeded skills context budget. All skill descriptions were removed."],
})
assert.equal(pressuredRead.status, 0)
assert.equal(pressuredRead.body.read_only_continuity_allowed, true)
assert.equal(pressuredRead.body.safe_for_external_writes, false)

const prohibited = run("prohibited", {
  ...base,
  required_skills: ["operator-continuity", "claude-gateway"],
  visible_executor_skills: ["github-review", "claude-gateway"],
})
assert.equal(prohibited.status, 64)
assert.equal(prohibited.body.status, "policy_rejected")

const duplicate = run("duplicate", {
  ...base,
  required_skills: ["operator-continuity", "operator-continuity"],
})
assert.equal(duplicate.status, 2)
assert.equal(duplicate.body.status, "invalid_input")

fs.rmSync(root, { recursive: true, force: true })
console.log("codex-skill-catalog-budget-guard self-test passed")
