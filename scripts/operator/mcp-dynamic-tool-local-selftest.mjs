import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "upp-mcp-dynamic-selftest-"))
const mock = path.join(root, "mock-mcp-server.mjs")
const executor = new URL("./mcp-dynamic-tool-local.mjs", import.meta.url)

fs.writeFileSync(
  mock,
  `let buffer = ""
let dynamic = false
let storedValue = null
process.stdin.setEncoding("utf8")
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n") }
function tool(name, description = name) { return { name, description, inputSchema: { type: "object", additionalProperties: true } } }
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf("\\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mock", version: "1" } } })
      continue
    }
    if (message.method === "notifications/initialized") continue
    if (message.method === "tools/list") {
      const tools = [tool("load_toolset")]
      if (dynamic) tools.push(tool("dynamic_read"), tool("dynamic_write"), tool("verify_value"))
      send({ jsonrpc: "2.0", id: message.id, result: { tools } })
      continue
    }
    if (message.method === "tools/call") {
      const name = message.params.name
      if (name === "load_toolset") {
        dynamic = true
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "loaded" }], isError: false } })
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      } else if (name === "dynamic_read" && dynamic) {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "dynamic-ready" }], isError: false } })
      } else if (name === "dynamic_write" && dynamic) {
        storedValue = message.params.arguments.value
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "written" }], isError: false } })
      } else if (name === "verify_value" && dynamic) {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "value=" + storedValue }], isError: false } })
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "unavailable" }], isError: true } })
      }
      continue
    }
  }
})
`,
)

const commonEnv = {
  ...process.env,
  OPERATOR_MCP_UPSTREAM_COMMAND: JSON.stringify([process.execPath, mock]),
  OPERATOR_MCP_ALLOWED_TOOLS: JSON.stringify(["load_toolset", "dynamic_read", "dynamic_write", "verify_value"]),
  OPERATOR_MCP_REQUEST_TIMEOUT_MS: "5000",
}

function run(record, env = commonEnv) {
  return spawnSync(process.execPath, [executor.pathname], {
    input: JSON.stringify(record),
    encoding: "utf8",
    env,
    timeout: 15000,
  })
}

const read = run({
  operation_id: "mcp-read-1",
  idempotency_key: "mcp-read-1-v1",
  action: "mcp_dynamic_tool_call",
  payload: {
    mode: "read",
    preload_calls: [{ name: "load_toolset", arguments: { name: "pcb_board" } }],
    tool_call: { name: "dynamic_read", arguments: {} },
  },
})
assert.equal(read.status, 0, read.stderr)
const readOutput = JSON.parse(read.stdout)
assert.equal(readOutput.verified, true)
assert.equal(readOutput.tool, "dynamic_read")
assert.equal(readOutput.target_result.content[0].text, "dynamic-ready")
assert.equal(readOutput.list_changed_notifications, 1)

const write = run({
  operation_id: "mcp-write-1",
  idempotency_key: "mcp-write-1-v1",
  action: "mcp_dynamic_tool_call",
  payload: {
    mode: "write",
    preload_calls: [{ name: "load_toolset", arguments: { name: "pcb_board" } }],
    tool_call: { name: "dynamic_write", arguments: { value: 42 } },
    verification_call: { name: "verify_value", arguments: {} },
    verification: { expect_text_includes: "value=42" },
  },
})
assert.equal(write.status, 0, write.stderr)
const writeOutput = JSON.parse(write.stdout)
assert.equal(writeOutput.verified, true)
assert.equal(writeOutput.verification_tool, "verify_value")

const denied = run({
  operation_id: "mcp-denied-1",
  idempotency_key: "mcp-denied-1-v1",
  action: "mcp_dynamic_tool_call",
  payload: {
    mode: "read",
    tool_call: { name: "not_allowed", arguments: {} },
  },
})
assert.notEqual(denied.status, 0)
assert.match(denied.stderr, /not in OPERATOR_MCP_ALLOWED_TOOLS/)

const forbidden = run(
  {
    operation_id: "mcp-forbidden-1",
    idempotency_key: "mcp-forbidden-1-v1",
    action: "mcp_dynamic_tool_call",
    payload: { mode: "read", tool_call: { name: "dynamic_read", arguments: {} } },
  },
  {
    ...commonEnv,
    OPERATOR_MCP_UPSTREAM_COMMAND: JSON.stringify([process.execPath, "/tmp/claude-mcp-server.mjs"]),
  },
)
assert.notEqual(forbidden.status, 0)
assert.match(forbidden.stderr, /prohibited provider or gateway identifier/)

fs.rmSync(root, { recursive: true, force: true })
console.log("dynamic MCP local executor self-test passed")
