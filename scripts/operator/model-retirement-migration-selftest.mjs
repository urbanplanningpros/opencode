import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { replaceRetiringModels, scanAndPatch } from "./model-retirement-migration.mjs"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-migration-"))

try {
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.mkdirSync(path.join(root, "docs"), { recursive: true })
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true })
  fs.mkdirSync(path.join(root, "production"), { recursive: true })

  fs.writeFileSync(path.join(root, "config", "dev.json"), '{"primary":"gpt-5.4","small":"gpt-5.4-mini"}\n')
  fs.writeFileSync(path.join(root, "docs", "migration.md"), "Use gpt-5.4 and gpt-5.4-mini.\n")
  fs.writeFileSync(path.join(root, ".github", "workflows", "agent.yml"), "model: gpt-5.4\n")
  fs.writeFileSync(path.join(root, "production", "runtime.toml"), 'model = "gpt-5.4-mini"\n')

  assert.equal(
    replaceRetiringModels("gpt-5.4-mini then gpt-5.4"),
    "gpt-5.6-luna then gpt-5.6-terra",
    "longer model identifier must be replaced first",
  )

  const scan = scanAndPatch({ root, mode: "scan" })
  assert.equal(scan.findings.length, 4)
  assert.equal(scan.status, "guided_intervention_required")
  assert.equal(scan.guided_intervention.length, 2)

  const receipt = path.join(root, ".operator-state", "migration.json")
  const applied = scanAndPatch({ root, mode: "apply-safe", receiptFile: receipt })
  assert.equal(applied.patches.length, 2)
  assert.equal(applied.guided_intervention.length, 2)
  assert.equal(applied.status, "guided_intervention_required")
  assert.ok(fs.existsSync(receipt))

  assert.match(fs.readFileSync(path.join(root, "config", "dev.json"), "utf8"), /gpt-5\.6-terra/)
  assert.match(fs.readFileSync(path.join(root, "config", "dev.json"), "utf8"), /gpt-5\.6-luna/)
  assert.doesNotMatch(fs.readFileSync(path.join(root, "docs", "migration.md"), "utf8"), /gpt-5\.4/)
  assert.match(fs.readFileSync(path.join(root, ".github", "workflows", "agent.yml"), "utf8"), /gpt-5\.4/)
  assert.match(fs.readFileSync(path.join(root, "production", "runtime.toml"), "utf8"), /gpt-5\.4-mini/)

  const second = scanAndPatch({ root, mode: "apply-safe" })
  assert.equal(second.patches.length, 0, "safe migration must be idempotent")
  assert.equal(second.guided_intervention.length, 2)

  console.log("model retirement migration self-test passed: 12 assertions")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
