import crypto from "node:crypto"
import { spawn } from "node:child_process"

function fail(message, code = 64) {
  console.error(message)
  process.exit(code)
}

function parseJson(value, name) {
  try {
    return JSON.parse(value)
  } catch (error) {
    fail(`${name} must be valid JSON: ${error.message}`)
  }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value == null || value === "" ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function validToolName(value, label) {
  const name = String(value ?? "").trim()
  if (!name || name.length > 256 || !/^[A-Za-z0-9_.:/-]+$/.test(name)) fail(`${label} is invalid`)
  return name
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
}

function resultFailed(result) {
  return result?.isError === true
}

class StdioMcpClient {
  constructor(command, options) {
    this.command = command
    this.timeoutMs = options.timeoutMs
    this.maxMessageBytes = options.maxMessageBytes
    this.maxStderrBytes = options.maxStderrBytes
    this.pending = new Map()
    this.notifications = []
    this.sequence = 0
    this.stdoutBuffer = ""
    this.stderrBuffer = ""
    this.closed = false
  }

  start() {
    const detached = process.platform !== "win32"
    this.child = spawn(this.command[0], this.command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached,
      windowsHide: true,
    })

    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk))
    this.child.stderr.on("data", (chunk) => {
      if (this.stderrBuffer.length < this.maxStderrBytes) {
        this.stderrBuffer += chunk.slice(0, this.maxStderrBytes - this.stderrBuffer.length)
      }
    })
    this.child.on("error", (error) => this.rejectAll(error))
    this.child.on("close", (code, signal) => {
      this.closed = true
      this.rejectAll(new Error(`MCP server exited before completion (code=${code}, signal=${signal ?? "none"})`))
    })
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxMessageBytes * 2) {
      this.rejectAll(new Error("MCP stdout buffer exceeded the configured limit"))
      this.close()
      return
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n")
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > this.maxMessageBytes) {
        this.rejectAll(new Error("MCP message exceeded the configured limit"))
        this.close()
        return
      }
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        this.rejectAll(new Error(`MCP server emitted invalid JSON: ${error.message}`))
        this.close()
        return
      }
      this.handleMessage(message)
    }
  }

  handleMessage(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(String(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(String(message.id))
      if (message.error) pending.reject(new Error(`MCP ${pending.method} failed: ${JSON.stringify(message.error)}`))
      else pending.resolve(message.result)
      return
    }

    if (message?.method && !Object.hasOwn(message, "id")) {
      this.notifications.push(message)
      return
    }

    if (message?.method && Object.hasOwn(message, "id")) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Server-initiated requests are disabled by the local operator shim" },
      })
    }
  }

  send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error("MCP server stdin is not writable")
    const encoded = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(encoded) > this.maxMessageBytes) throw new Error("Outbound MCP message exceeded the configured limit")
    this.child.stdin.write(encoded)
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params })
  }

  request(method, params = {}) {
    const id = `upp-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  close() {
    if (!this.child || this.closed) return
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {}
    const pid = this.child.pid
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM")
      else this.child.kill("SIGTERM")
    } catch {}
    const timer = setTimeout(() => {
      try {
        if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL")
        else this.child.kill("SIGKILL")
      } catch {}
    }, 1000)
    timer.unref()
  }
}

async function listAllTools(client, maxPages, maxTools) {
  const tools = []
  let cursor
  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.request("tools/list", cursor ? { cursor } : {})
    if (!Array.isArray(result?.tools)) throw new Error("MCP tools/list returned no tools array")
    tools.push(...result.tools)
    if (tools.length > maxTools) throw new Error(`MCP tool count exceeded ${maxTools}`)
    if (!result.nextCursor) return tools
    cursor = result.nextCursor
  }
  throw new Error(`MCP tools/list exceeded ${maxPages} pages`)
}

let input = ""
for await (const chunk of process.stdin) input += chunk
let record
try {
  record = JSON.parse(input)
} catch (error) {
  fail(`invalid queue record: ${error.message}`)
}

if (record.action !== "mcp_dynamic_tool_call") fail(`unsupported action: ${record.action}`)
if (!record.operation_id || !record.idempotency_key) fail("operation_id and idempotency_key are required")

const command = parseJson(process.env.OPERATOR_MCP_UPSTREAM_COMMAND || "", "OPERATOR_MCP_UPSTREAM_COMMAND")
if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part.trim())) {
  fail("OPERATOR_MCP_UPSTREAM_COMMAND must be a non-empty JSON string array")
}
const forbiddenRoute = /(^|[^a-z])(anthropic|claude|manus|openrouter|bedrock|vertex|copilot)([^a-z]|$)/i
if (forbiddenRoute.test(command.join(" "))) fail("the configured MCP command contains a prohibited provider or gateway identifier")

const allowedList = parseJson(process.env.OPERATOR_MCP_ALLOWED_TOOLS || "", "OPERATOR_MCP_ALLOWED_TOOLS")
if (!Array.isArray(allowedList) || allowedList.length === 0) fail("OPERATOR_MCP_ALLOWED_TOOLS must be a non-empty JSON array")
const allowedTools = new Set(allowedList.map((name) => validToolName(name, "allowed tool")))

const payload = record.payload ?? {}
const mode = payload.mode === "write" ? "write" : payload.mode === "read" || payload.mode == null ? "read" : fail("payload.mode must be read or write")
const preloadCalls = Array.isArray(payload.preload_calls) ? payload.preload_calls : []
const maxPreloads = boundedInteger(process.env.OPERATOR_MCP_MAX_PRELOAD_CALLS, 8, 0, 32, "OPERATOR_MCP_MAX_PRELOAD_CALLS")
if (preloadCalls.length > maxPreloads) fail(`payload.preload_calls exceeds ${maxPreloads}`)

function normalizeCall(call, label) {
  if (!call || typeof call !== "object" || Array.isArray(call)) fail(`${label} must be an object`)
  const name = validToolName(call.name, `${label}.name`)
  if (!allowedTools.has(name)) fail(`${label}.name is not in OPERATOR_MCP_ALLOWED_TOOLS`)
  const args = call.arguments == null ? {} : call.arguments
  if (!args || typeof args !== "object" || Array.isArray(args)) fail(`${label}.arguments must be an object`)
  return { name, arguments: args }
}

const normalizedPreloads = preloadCalls.map((call, index) => normalizeCall(call, `payload.preload_calls[${index}]`))
const toolCall = normalizeCall(payload.tool_call, "payload.tool_call")
let verificationCall = null
let expectedText = null
if (mode === "write") {
  verificationCall = normalizeCall(payload.verification_call, "payload.verification_call")
  expectedText = String(payload.verification?.expect_text_includes ?? "")
  if (!expectedText) fail("write mode requires payload.verification.expect_text_includes")
}

const timeoutMs = boundedInteger(process.env.OPERATOR_MCP_REQUEST_TIMEOUT_MS, 30000, 1000, 300000, "OPERATOR_MCP_REQUEST_TIMEOUT_MS")
const maxMessageBytes = boundedInteger(process.env.OPERATOR_MCP_MAX_MESSAGE_BYTES, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024, "OPERATOR_MCP_MAX_MESSAGE_BYTES")
const maxStderrBytes = boundedInteger(process.env.OPERATOR_MCP_MAX_STDERR_BYTES, 64 * 1024, 1024, 1024 * 1024, "OPERATOR_MCP_MAX_STDERR_BYTES")
const maxPages = boundedInteger(process.env.OPERATOR_MCP_MAX_TOOL_PAGES, 100, 1, 1000, "OPERATOR_MCP_MAX_TOOL_PAGES")
const maxTools = boundedInteger(process.env.OPERATOR_MCP_MAX_TOOLS, 10000, 1, 100000, "OPERATOR_MCP_MAX_TOOLS")
const protocolVersion = process.env.OPERATOR_MCP_PROTOCOL_VERSION || "2025-06-18"
const client = new StdioMcpClient(command, { timeoutMs, maxMessageBytes, maxStderrBytes })

try {
  client.start()
  await client.request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "upp-operator-mcp-local", version: "1.0.0" },
  })
  client.notify("notifications/initialized")

  for (const call of normalizedPreloads) {
    const preloadResult = await client.request("tools/call", { name: call.name, arguments: call.arguments })
    if (resultFailed(preloadResult)) throw new Error(`preload tool ${call.name} returned isError=true`)
  }

  const tools = await listAllTools(client, maxPages, maxTools)
  const toolNames = new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === "string"))
  if (!toolNames.has(toolCall.name)) throw new Error(`dynamic tool ${toolCall.name} was not present after preload and refreshed tools/list`)
  if (verificationCall && !toolNames.has(verificationCall.name)) {
    throw new Error(`verification tool ${verificationCall.name} was not present after preload and refreshed tools/list`)
  }

  const targetResult = await client.request("tools/call", { name: toolCall.name, arguments: toolCall.arguments })
  if (resultFailed(targetResult)) throw new Error(`target tool ${toolCall.name} returned isError=true`)

  let verificationResult = null
  let verified = mode === "read"
  if (mode === "write") {
    verificationResult = await client.request("tools/call", {
      name: verificationCall.name,
      arguments: verificationCall.arguments,
    })
    verified = !resultFailed(verificationResult) && resultText(verificationResult).includes(expectedText)
  }

  const targetText = resultText(targetResult)
  const verificationText = resultText(verificationResult)
  const receipt = {
    verified,
    operation_id: record.operation_id,
    mode,
    tool: toolCall.name,
    available_tool_count: toolNames.size,
    list_changed_notifications: client.notifications.filter((item) => item.method === "notifications/tools/list_changed").length,
    target_result: targetResult,
    target_result_sha256: crypto.createHash("sha256").update(JSON.stringify(targetResult)).digest("hex"),
    target_text_bytes: Buffer.byteLength(targetText),
    verification_tool: verificationCall?.name ?? null,
    verification_result_sha256: verificationResult
      ? crypto.createHash("sha256").update(JSON.stringify(verificationResult)).digest("hex")
      : null,
    verification_text_bytes: Buffer.byteLength(verificationText),
  }
  process.stdout.write(JSON.stringify(receipt))
  process.exitCode = verified ? 0 : 70
} catch (error) {
  console.error(error.message)
  if (client.stderrBuffer) console.error(`MCP stderr (bounded): ${client.stderrBuffer}`)
  process.exitCode = 70
} finally {
  client.close()
}
