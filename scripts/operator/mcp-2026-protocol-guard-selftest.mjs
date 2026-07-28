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
    discovery: { load_requested: false, tools: ["read_state", "write_state", "verify_state"], skills: [] },
    plugin_features: {
      apps_enabled: true,
      plugins_enabled: true,
      recommended_plugins: false,
      tool_suggest: false,
      request_plugin_install_exposed: false,
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

const recommendationOnly = basePlan()
recommendationOnly.plugin_features.recommended_plugins = true
const recommendationOnlyResult = run(recommendationOnly)
assert.equal(recommendationOnlyResult.status, 0, recommendationOnlyResult.stderr)
assert.equal(JSON.parse(recommendationOnlyResult.stdout).normalized.request_plugin_install_exposed, false)

const toolSuggest = basePlan()
toolSuggest.plugin_features.tool_suggest = true
const toolSuggestResult = run(toolSuggest)
assert.equal(toolSuggestResult.status, 64)
assert.match(toolSuggestResult.stdout, /tool_suggest must remain disabled/)

const installTool = basePlan()
installTool.plugin_features.request_plugin_install_exposed = true
const installToolResult = run(installTool)
assert.equal(installToolResult.status, 64)
assert.match(installToolResult.stdout, /request_plugin_install/)

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
canaryRead.discovery = { load_requested: true, tools: ["read_state", "write_state", "verify_state"], skills: [] }
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

const validFallback = structuredClone(canaryRead)
validFallback.discovery = {
  load_requested: false,
  tools: ["read_state", "write_state", "verify_state"],
  skills: [],
  legacy_fallback: {
    requested: true,
    same_server_identity: true,
    http_status: 400,
    response_id: null,
    error_code: -32000,
    message: "Bad Request: Unsupported protocol version (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05)",
    content_type: "text/plain",
    negotiated_protocol_version: "2025-11-25",
  },
}
validFallback.task = { enabled: false }
const validFallbackResult = run(validFallback)
assert.equal(validFallbackResult.status, 0, validFallbackResult.stderr)
assert.equal(JSON.parse(validFallbackResult.stdout).normalized.effective_protocol_version, "2025-11-25")

const missingSessionFallback = structuredClone(validFallback)
missingSessionFallback.discovery.legacy_fallback.message = "Bad Request: No valid session ID provided"
const missingSessionResult = run(missingSessionFallback)
assert.equal(missingSessionResult.status, 0, missingSessionResult.stderr)

const unknownVersionFallback = structuredClone(validFallback)
unknownVersionFallback.discovery.legacy_fallback.message = "Bad Request: Unsupported protocol version (supported versions: 2025-11-25, 2099-01-01)"
const unknownVersionResult = run(unknownVersionFallback)
assert.equal(unknownVersionResult.status, 64)
assert.match(unknownVersionResult.stdout, /exclusively supported legacy-version list/)

const correlatedFallback = structuredClone(validFallback)
correlatedFallback.discovery.legacy_fallback.response_id = 7
const correlatedFallbackResult = run(correlatedFallback)
assert.equal(correlatedFallbackResult.status, 64)
assert.match(correlatedFallbackResult.stdout, /null JSON-RPC response ID/)

const fallbackTask = structuredClone(validFallback)
fallbackTask.task = structuredClone(canaryRead.task)
const fallbackTaskResult = run(fallbackTask)
assert.equal(fallbackTaskResult.status, 64)
assert.match(fallbackTaskResult.stdout, /unavailable after legacy initialization fallback/)

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
