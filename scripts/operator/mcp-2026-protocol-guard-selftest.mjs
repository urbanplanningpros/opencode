import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "mcp-2026-protocol-guard.mjs")
const hashA = "a".repeat(64)
const hashB = "b".repeat(64)
const hashC = "c".repeat(64)

function basePlan() {
  return {
    protocol_version: "2025-11-25",
    environment: "production",
    server: {
      name: "approved-local-mcp",
      route: "local",
      transport: "stdio",
      command: [path.resolve("/approved/bin/mcp-server"), "--stdio"],
      identity_sha256: hashA,
    },
    capabilities: { discovery: false, tasks: false },
    allowlists: { tools: ["read_state", "write_state", "verify_state"], skills: [] },
    discovery: {
      load_requested: false,
      tools: ["read_state", "write_state", "verify_state"],
      skills: [],
      rejected_tools: [],
      required_tools: ["read_state"],
    },
    plugin_policy: {
      tool_plugin_required_action: "deny",
      recommended_plugins: [],
      required_plugins: [],
      installed_plugins: [],
    },
    task: { enabled: false },
  }
}

function run(plan) {
  return spawnSync(process.execPath, [guard, "--json"], {
    input: JSON.stringify(plan),
    encoding: "utf8",
    timeout: 10000,
  })
}

const legacy = run(basePlan())
assert.equal(legacy.status, 0, legacy.stderr)
assert.equal(JSON.parse(legacy.stdout).allowed, true)

const mixedLegacyCatalog = basePlan()
mixedLegacyCatalog.discovery.rejected_tools = ["malformed_legacy_tool"]
const mixedLegacyResult = run(mixedLegacyCatalog)
assert.equal(mixedLegacyResult.status, 0, mixedLegacyResult.stderr)
assert.equal(JSON.parse(mixedLegacyResult.stdout).normalized.catalog_degraded, true)

const rejectedRequiredTool = basePlan()
rejectedRequiredTool.discovery.rejected_tools = ["read_state"]
rejectedRequiredTool.discovery.tools = ["write_state", "verify_state"]
const rejectedRequiredResult = run(rejectedRequiredTool)
assert.equal(rejectedRequiredResult.status, 64)
assert.match(rejectedRequiredResult.stdout, /required tool 'read_state'/)

const recommendationOnly = basePlan()
recommendationOnly.plugin_policy.recommended_plugins = ["review-only-plugin"]
const recommendationOnlyResult = run(recommendationOnly)
assert.equal(recommendationOnlyResult.status, 0, recommendationOnlyResult.stderr)

const requiredPluginMissing = basePlan()
requiredPluginMissing.plugin_policy.required_plugins = ["approved-required-plugin"]
const requiredPluginMissingResult = run(requiredPluginMissing)
assert.equal(requiredPluginMissingResult.status, 64)
assert.match(requiredPluginMissingResult.stdout, /not installed and verified/)

const toolInstallAllowed = basePlan()
toolInstallAllowed.plugin_policy.tool_plugin_required_action = "allow"
const toolInstallAllowedResult = run(toolInstallAllowed)
assert.equal(toolInstallAllowedResult.status, 64)
assert.match(toolInstallAllowedResult.stdout, /must be 'deny'/)

const production2026 = basePlan()
production2026.protocol_version = "2026-07-28"
production2026.capabilities.discovery = true
const productionDenied = run(production2026)
assert.equal(productionDenied.status, 64)
assert.match(productionDenied.stdout, /canary-only/)

const canaryRead = basePlan()
canaryRead.protocol_version = "2026-07-28"
canaryRead.environment = "canary"
canaryRead.capabilities = { discovery: true, tasks: true }
canaryRead.discovery = {
  load_requested: true,
  tools: ["read_state", "write_state", "verify_state"],
  skills: [],
  rejected_tools: [],
  required_tools: ["read_state"],
}
canaryRead.task = {
  enabled: true,
  mode: "read",
  operation_id: "mcp-task-read-001",
  idempotency_key: "mcp-task-read-001-v1",
  tool: "read_state",
  arguments_sha256: hashB,
}
const canaryReadResult = run(canaryRead)
assert.equal(canaryReadResult.status, 0, canaryReadResult.stderr)
assert.equal(JSON.parse(canaryReadResult.stdout).normalized.task_enabled, true)

const unallowlisted = structuredClone(canaryRead)
unallowlisted.discovery.tools.push("surprise_write")
const unallowlistedResult = run(unallowlisted)
assert.equal(unallowlistedResult.status, 64)
assert.match(unallowlistedResult.stdout, /not exactly allowlisted/)

const excludedRoute = structuredClone(canaryRead)
excludedRoute.server.command = [path.resolve("/approved/bin/provider-gateway"), "--stdio"]
const excludedRouteResult = run(excludedRoute)
assert.equal(excludedRouteResult.status, 64)
assert.match(excludedRouteResult.stdout, /excluded provider/)

const writeWithoutVerification = structuredClone(canaryRead)
writeWithoutVerification.task = {
  enabled: true,
  mode: "write",
  operation_id: "mcp-task-write-001",
  idempotency_key: "mcp-task-write-001-v1",
  tool: "write_state",
  arguments_sha256: hashB,
}
const writeDenied = run(writeWithoutVerification)
assert.equal(writeDenied.status, 64)
assert.match(writeDenied.stdout, /independent verification/)

const verifiedWrite = structuredClone(writeWithoutVerification)
verifiedWrite.task.verification = { tool: "verify_state", expected_sha256: hashC }
const verifiedWriteResult = run(verifiedWrite)
assert.equal(verifiedWriteResult.status, 0, verifiedWriteResult.stderr)
assert.equal(JSON.parse(verifiedWriteResult.stdout).normalized.task_mode, "write")

console.log("MCP 2026 protocol guard self-test passed")
