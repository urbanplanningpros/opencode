import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-mcp-config-persistence-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-guard-"))
const config = path.join(temp, "config.toml")
const manifest = path.join(temp, "manifest.json")
const inventory = path.join(temp, "inventory.json")
const backups = path.join(temp, "backups")
let checks = 0

function run(args, env = {}) {
  return spawnSync(process.execPath, [guard, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

function expectStatus(result, code, status) {
  assert.equal(result.status, code, `expected exit ${code}; stdout=${result.stdout}; stderr=${result.stderr}`)
  const text = result.stdout || result.stderr
  const parsed = JSON.parse(text)
  assert.equal(parsed.status, status)
  checks += 1
  return parsed
}

try {
  fs.writeFileSync(config, [
    'model = "gpt-5.6-sol"',
    '',
    '[mcp_servers.cloudmind]',
    'url = "https://example.invalid/mcp"',
    'bearer_token_env_var = "CLOUDMIND_BEARER_TOKEN"',
    '',
    '[mcp_servers.cloudmind.headers]',
    'X-Client = "operator"',
    '',
    '[mcp_servers.computer_use]',
    'command = "computer-use"',
    '',
  ].join("\n"))

  expectStatus(run([
    "snapshot",
    "--config", config,
    "--manifest", manifest,
    "--operation-id", "mcp-persistence-selftest",
    "--servers-json", '["cloudmind","computer_use"]',
    "--tool-prefixes-json", '{"cloudmind":["mcp__cloudmind__"],"computer_use":["mcp__computer_use__"]}',
  ]), 0, "snapshot_created")

  const saved = JSON.parse(fs.readFileSync(manifest, "utf8"))
  assert.deepEqual(Object.keys(saved.servers).sort(), ["cloudmind", "computer_use"])
  assert.equal(saved.safeguards.manifest_may_contain_local_secret_material, true)
  assert.equal(saved.safeguards.commit_manifest_to_repository, false)
  checks += 1

  expectStatus(run(["audit", "--config", config, "--manifest", manifest]), 0, "mcp_config_intact")

  fs.writeFileSync(config, 'model = "gpt-5.6-sol"\n')
  const drift = expectStatus(run(["audit", "--config", config, "--manifest", manifest]), 75, "mcp_config_drift")
  assert.deepEqual(drift.missing_servers.sort(), ["cloudmind", "computer_use"])
  checks += 1

  expectStatus(run([
    "repair", "--config", config, "--manifest", manifest, "--backup-dir", backups, "--execute",
  ]), 78, "blocked")

  const repaired = expectStatus(run([
    "repair", "--config", config, "--manifest", manifest, "--backup-dir", backups, "--execute",
  ], { OPERATOR_AUTHORIZED_LOCAL_EXECUTOR: "1" }), 0, "mcp_config_repaired")
  assert.deepEqual(repaired.restored_servers.sort(), ["cloudmind", "computer_use"])
  const repairedText = fs.readFileSync(config, "utf8")
  assert.match(repairedText, /model = "gpt-5\.6-sol"/)
  assert.match(repairedText, /\[mcp_servers\.cloudmind\]/)
  assert.match(repairedText, /\[mcp_servers\.computer_use\]/)
  checks += 1

  expectStatus(run(["repair", "--config", config, "--manifest", manifest, "--execute"], {
    OPERATOR_AUTHORIZED_LOCAL_EXECUTOR: "1",
  }), 0, "repair_not_needed")

  fs.writeFileSync(inventory, JSON.stringify({ tools: [{ name: "mcp__cloudmind__search" }] }))
  const missingRuntime = expectStatus(run([
    "post-restart-check", "--manifest", manifest, "--inventory-json", inventory,
  ]), 75, "mcp_runtime_not_ready")
  assert.equal(missingRuntime.missing[0].server, "computer_use")
  checks += 1

  fs.writeFileSync(inventory, JSON.stringify({ tools: [
    { name: "mcp__cloudmind__search" },
    { name: "mcp__computer_use__click" },
  ] }))
  expectStatus(run([
    "post-restart-check", "--manifest", manifest, "--inventory-json", inventory,
  ]), 0, "mcp_runtime_verified")

  const changed = repairedText.replace('url = "https://example.invalid/mcp"', 'url = "https://changed.invalid/mcp"')
  fs.writeFileSync(config, changed)
  expectStatus(run([
    "repair", "--config", config, "--manifest", manifest, "--execute",
  ], { OPERATOR_AUTHORIZED_LOCAL_EXECUTOR: "1" }), 75, "blocked")
  assert.match(fs.readFileSync(config, "utf8"), /changed\.invalid/)
  checks += 1

  expectStatus(run([
    "audit", "--config", config, "--manifest", manifest, "--model", "auto",
  ]), 78, "blocked")

  expectStatus(run([
    "audit", "--config", config, "--manifest", manifest, "--gateway", "model-router",
  ]), 78, "blocked")

  console.log(JSON.stringify({ status: "passed", checks }, null, 2))
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
