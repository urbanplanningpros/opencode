#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-registry-sandbox-"))
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-tool-registry-sandbox-guard.mjs")

function run(name, evidence, expectedExit, expectedStatus) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedExit) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${name}: expected exit ${expectedExit}, got ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedStatus) throw new Error(`${name}: expected ${expectedStatus}, got ${output.status}`)
  return output
}

const base = {
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  tool_registry: {
    reserved_host_names: ["tool_search"],
    host_tools: [{ name: "tool_search", normalized_name: "tool_search", runtime_id: "host-tool-search", registered_index: 0, protected: true }],
    external_tools: [
      { name: "search-files", normalized_name: "search_files", runtime_id: "mcp-search-files-a", registered_index: 1 },
      { name: "search_files", normalized_name: "search_files", runtime_id: "mcp-search-files-b", registered_index: 2 },
    ],
    normalized_collisions: [
      {
        normalized_name: "search_files",
        first_runtime_id: "mcp-search-files-a",
        selected_runtime_id: "mcp-search-files-a",
        duplicate_skipped: true,
      },
    ],
    model_declarations: [{ normalized_name: "search_files", runtime_id: "mcp-search-files-a" }],
    dispatch_bindings: [{ normalized_name: "search_files", runtime_id: "mcp-search-files-a" }],
  },
  readiness: {
    selected_runtime_id: "mcp-search-files-a",
    wait_runtime_id: "mcp-search-files-a",
    wait_completed: true,
    execution_gate_acquired_after_wait: true,
  },
  skill_sandbox: {
    restricted_session: true,
    filesystem_context_id: "sandbox-123",
    capability_discovery_context_id: "sandbox-123",
    skill_read_context_id: "sandbox-123",
    executor_supports_sandbox_discovery: true,
    cache_key_includes_context: true,
    symlink_targets_omitted: true,
    denied_references_exposed: false,
    turn_permission_grants_applied: true,
    resource_size_limit_enforced: true,
    root_count: 129,
    batch_size: 128,
    batch_count: 2,
    restricted_windows_read: false,
    windows_read_sandbox_supported: true,
    failed_closed: false,
  },
}

try {
  run("healthy", base, 0, "compatible")

  const hostCollision = structuredClone(base)
  hostCollision.tool_registry.external_tools.push({
    name: "tool-search",
    normalized_name: "tool_search",
    runtime_id: "external-tool-search",
    registered_index: 3,
  })
  const hostResult = run("host-collision", hostCollision, 64, "blocked")
  if (!hostResult.blocked.includes("external_tool_collides_with_reserved_host:tool_search")) {
    throw new Error("host-collision: reserved host collision not blocked")
  }

  const dispatchMismatch = structuredClone(base)
  dispatchMismatch.tool_registry.dispatch_bindings[0].runtime_id = "mcp-search-files-b"
  const dispatchResult = run("dispatch-mismatch", dispatchMismatch, 64, "blocked")
  if (!dispatchResult.blocked.includes("normalized_tool_collision_dispatch_mismatch:search_files")) {
    throw new Error("dispatch-mismatch: inconsistent runtime dispatch not blocked")
  }

  const sandboxMismatch = structuredClone(base)
  sandboxMismatch.skill_sandbox.skill_read_context_id = "sandbox-other"
  sandboxMismatch.skill_sandbox.symlink_targets_omitted = false
  sandboxMismatch.skill_sandbox.cache_key_includes_context = false
  const sandboxResult = run("sandbox-mismatch", sandboxMismatch, 64, "blocked")
  if (!sandboxResult.blocked.includes("skill_read_context_mismatch")) throw new Error("sandbox-mismatch: context drift not blocked")
  if (!sandboxResult.blocked.includes("inaccessible_or_external_symlink_target_exposed")) {
    throw new Error("sandbox-mismatch: symlink exposure not blocked")
  }

  const oversizedBatch = structuredClone(base)
  oversizedBatch.skill_sandbox.batch_size = 129
  const batchResult = run("oversized-batch", oversizedBatch, 64, "blocked")
  if (!batchResult.blocked.includes("capability_root_batch_size_exceeds_128")) {
    throw new Error("oversized-batch: root batching limit not enforced")
  }

  const windowsUnsafe = structuredClone(base)
  windowsUnsafe.skill_sandbox.restricted_windows_read = true
  windowsUnsafe.skill_sandbox.windows_read_sandbox_supported = false
  windowsUnsafe.skill_sandbox.failed_closed = false
  const windowsResult = run("windows-unsafe", windowsUnsafe, 64, "blocked")
  if (!windowsResult.blocked.includes("restricted_windows_skill_read_not_failed_closed")) {
    throw new Error("windows-unsafe: unsupported restricted read did not fail closed")
  }

  const waiting = structuredClone(base)
  waiting.readiness.wait_completed = false
  run("waiting", waiting, 75, "remediation_required")

  const prohibited = structuredClone(base)
  prohibited.routing = { provider: "anthropic", route: "gateway", automatic_selector: true, model_gateway: true }
  run("prohibited", prohibited, 64, "blocked")

  console.log("Codex tool-registry and skill-sandbox guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
