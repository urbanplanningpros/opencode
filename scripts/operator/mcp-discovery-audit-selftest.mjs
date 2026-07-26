import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-discovery-audit-"))
const cache = path.join(root, "plugins", "cache", "openai-bundled", "computer-use", "1.0.0")
fs.mkdirSync(cache, { recursive: true })
fs.writeFileSync(
  path.join(root, "config.toml"),
  [
    'model = "gpt-5.6-sol"',
    "",
    "[mcp_servers.computer-use]",
    'command = "./Codex Computer Use.app/Contents/MacOS/client"',
    'args = ["mcp"]',
    'cwd = "."',
    "enabled = false",
    "",
    "[mcp_servers.safe]",
    'command = "/usr/local/bin/safe"',
    "enabled = true",
    "",
  ].join("\n"),
)
fs.writeFileSync(
  path.join(cache, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        "computer-use": { command: "./bin/launcher", args: ["mcp"], cwd: "." },
        safe: { command: "/usr/bin/safe" },
      },
    },
    null,
    2,
  )}\n`,
)

const audit = path.join(import.meta.dirname, "mcp-discovery-audit.mjs")
const run = (...args) =>
  spawnSync(process.execPath, [audit, "--codex-home", root, "--json", ...args], {
    encoding: "utf8",
  })

try {
  const before = run()
  assert.equal(before.status, 2, before.stderr)
  const beforeReport = JSON.parse(before.stdout)
  assert.equal(beforeReport.findings.length, 2)
  assert.equal(beforeReport.safe_for_third_party_discovery, false)

  const applied = run("--apply", "--quarantine-cache")
  assert.equal(applied.status, 0, applied.stderr)
  const appliedReport = JSON.parse(applied.stdout)
  assert.equal(appliedReport.modified.length, 2)
  assert.equal(appliedReport.safe_for_third_party_discovery, true)
  assert.ok(appliedReport.backup_root)
  assert.ok(fs.existsSync(path.join(appliedReport.backup_root, "manifest.json")))

  const config = fs.readFileSync(path.join(root, "config.toml"), "utf8")
  assert.equal(config.includes("mcp_servers.computer-use"), false)
  assert.equal(config.includes("mcp_servers.safe"), true)

  const plugin = JSON.parse(fs.readFileSync(path.join(cache, ".mcp.json"), "utf8"))
  assert.equal("computer-use" in plugin.mcpServers, false)
  assert.equal("safe" in plugin.mcpServers, true)

  const after = run()
  assert.equal(after.status, 0, after.stderr)
  assert.equal(JSON.parse(after.stdout).remaining.length, 0)
  console.log("MCP discovery audit self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
