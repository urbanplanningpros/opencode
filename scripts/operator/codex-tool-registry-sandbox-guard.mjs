#!/usr/bin/env node
import fs from "node:fs"

function parseArgs(values) {
  const args = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = values[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_")
}

const prohibited = [
  "anthropic",
  "claude",
  "manus",
  "openrouter",
  "litellm",
  "bedrock",
  "vertex",
  "copilot-auto",
  "model-gateway",
]

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-tool-registry-sandbox-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  evidence = JSON.parse(fs.readFileSync(args.input, "utf8"))
} catch (error) {
  console.error(`Unable to read tool-registry evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const routeReceipt = `${provider} ${route}`
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.some((name) => routeReceipt.includes(name))) blocked.push("prohibited_provider_or_gateway")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const registry = evidence.tool_registry || {}
const hostTools = Array.isArray(registry.host_tools) ? registry.host_tools : []
const externalTools = Array.isArray(registry.external_tools) ? registry.external_tools : []
const declarations = Array.isArray(registry.model_declarations) ? registry.model_declarations : []
const dispatch = Array.isArray(registry.dispatch_bindings) ? registry.dispatch_bindings : []
const collisions = Array.isArray(registry.normalized_collisions) ? registry.normalized_collisions : []
const reservedHostNames = new Set(
  (Array.isArray(registry.reserved_host_names) ? registry.reserved_host_names : ["tool_search"]).map(normalized).filter(Boolean),
)

if (hostTools.length === 0) blocked.push("host_tool_registry_missing")
if (reservedHostNames.size === 0) blocked.push("reserved_host_tool_names_missing")

const allTools = [...hostTools.map((tool) => ({ ...tool, kind: "host" })), ...externalTools.map((tool) => ({ ...tool, kind: "external" }))]
const grouped = new Map()
for (const tool of allTools) {
  const key = normalized(tool.normalized_name || tool.name)
  if (!key) {
    blocked.push(`tool_name_missing:${text(tool.runtime_id) || "unknown"}`)
    continue
  }
  if (!grouped.has(key)) grouped.set(key, [])
  grouped.get(key).push({ ...tool, key, index: Number.isFinite(Number(tool.registered_index)) ? Number(tool.registered_index) : Number.MAX_SAFE_INTEGER })
}

for (const reserved of reservedHostNames) {
  const matching = grouped.get(reserved) || []
  const hosts = matching.filter((tool) => tool.kind === "host")
  const externals = matching.filter((tool) => tool.kind === "external")
  if (hosts.length === 0) blocked.push(`reserved_host_tool_missing:${reserved}`)
  if (hosts.some((tool) => tool.protected !== true)) blocked.push(`reserved_host_tool_not_protected:${reserved}`)
  if (externals.length > 0) blocked.push(`external_tool_collides_with_reserved_host:${reserved}`)
  if (matching.length > 1) {
    const first = [...matching].sort((left, right) => left.index - right.index)[0]
    if (first?.kind !== "host") blocked.push(`reserved_host_tool_not_registered_first:${reserved}`)
  }
}

for (const [key, tools] of grouped.entries()) {
  if (tools.length < 2 || reservedHostNames.has(key)) continue
  const ordered = [...tools].sort((left, right) => left.index - right.index)
  const expectedRuntime = text(ordered[0].runtime_id)
  const collision = collisions.find((item) => normalized(item.normalized_name) === key)
  const declaration = declarations.find((item) => normalized(item.normalized_name) === key)
  const binding = dispatch.find((item) => normalized(item.normalized_name) === key)
  if (!collision) blocked.push(`normalized_tool_collision_receipt_missing:${key}`)
  else {
    if (text(collision.first_runtime_id) !== expectedRuntime) blocked.push(`normalized_tool_collision_first_runtime_mismatch:${key}`)
    if (text(collision.selected_runtime_id) !== expectedRuntime) blocked.push(`normalized_tool_collision_selected_runtime_mismatch:${key}`)
    if (collision.duplicate_skipped !== true) blocked.push(`normalized_tool_collision_duplicate_not_skipped:${key}`)
  }
  if (!declaration || text(declaration.runtime_id) !== expectedRuntime) {
    blocked.push(`normalized_tool_collision_declaration_mismatch:${key}`)
  }
  if (!binding || text(binding.runtime_id) !== expectedRuntime) {
    blocked.push(`normalized_tool_collision_dispatch_mismatch:${key}`)
  }
}

const readiness = evidence.readiness || {}
if (!text(readiness.selected_runtime_id)) blocked.push("selected_tool_runtime_missing")
if (text(readiness.wait_runtime_id) !== text(readiness.selected_runtime_id)) blocked.push("readiness_wait_runtime_mismatch")
if (readiness.wait_completed !== true) remediation.push("wait_for_exact_selected_tool_runtime")
if (readiness.execution_gate_acquired_after_wait !== true) blocked.push("tool_execution_gate_acquired_before_readiness")

const sandbox = evidence.skill_sandbox || {}
const contextId = text(sandbox.filesystem_context_id)
if (!contextId) blocked.push("filesystem_sandbox_context_missing")
if (text(sandbox.capability_discovery_context_id) !== contextId) blocked.push("capability_discovery_context_mismatch")
if (text(sandbox.skill_read_context_id) !== contextId) blocked.push("skill_read_context_mismatch")
if (sandbox.restricted_session === true && sandbox.executor_supports_sandbox_discovery !== true) {
  blocked.push("restricted_executor_lacks_sandbox_discovery_support")
}
if (sandbox.cache_key_includes_context !== true) blocked.push("capability_cache_not_bound_to_sandbox_context")
if (sandbox.symlink_targets_omitted !== true) blocked.push("inaccessible_or_external_symlink_target_exposed")
if (sandbox.denied_references_exposed === true) blocked.push("denied_skill_reference_exposed")
if (sandbox.turn_permission_grants_applied !== true) blocked.push("turn_scoped_permission_grants_not_applied")
if (sandbox.resource_size_limit_enforced !== true) blocked.push("skill_resource_size_limit_not_enforced")

const rootCount = Number(sandbox.root_count || 0)
const batchSize = Number(sandbox.batch_size || 0)
const batchCount = Number(sandbox.batch_count || 0)
if (rootCount > 128) {
  if (!(batchSize > 0 && batchSize <= 128)) blocked.push("capability_root_batch_size_exceeds_128")
  if (batchCount < Math.ceil(rootCount / Math.max(batchSize, 1))) blocked.push("capability_root_batch_count_incomplete")
}
if (sandbox.restricted_windows_read === true && sandbox.windows_read_sandbox_supported !== true) {
  if (sandbox.failed_closed !== true) blocked.push("restricted_windows_skill_read_not_failed_closed")
  else warnings.push("restricted_windows_skill_read_denied_as_required")
}

if (blocked.length > 0) {
  remediation.push("reserve_and_register_host_tools_before_external_tools")
  remediation.push("bind_model_declarations_and_dispatch_to_the_same_first_registered_runtime")
  remediation.push("apply_the_active_filesystem_sandbox_context_to_discovery_and_skill_reads")
  remediation.push("omit_inaccessible_roots_and_symlink_targets_and_fail_closed_when_sandboxing_is_unavailable")
}

const unique = (values) => [...new Set(values)]
const result = {
  status: blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible",
  blocked: unique(blocked),
  remediation: unique(remediation),
  warnings: unique(warnings),
  upstream_baseline: {
    host_tool_protection: "openai/codex#36127 and #36129",
    skill_sandboxing: "openai/codex#36121 and #36124",
    runtime_readiness: "openai/codex#36120",
  },
}

if (args.json) console.log(JSON.stringify(result, null, 2))
else console.log(`${result.status}: ${[...result.blocked, ...result.remediation].join(", ") || "verified"}`)
process.exit(result.status === "compatible" ? 0 : result.status === "remediation_required" ? 75 : 64)
