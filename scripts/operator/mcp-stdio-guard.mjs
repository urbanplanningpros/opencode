import readline from "node:readline"
import { spawn } from "node:child_process"

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer`)
    process.exit(64)
  }
  return value
}

function commandFromEnvironment() {
  const raw = process.env.OPERATOR_MCP_UPSTREAM_COMMAND
  if (!raw) {
    console.error('OPERATOR_MCP_UPSTREAM_COMMAND is required, for example ["node","server.mjs"]')
    process.exit(64)
  }
  let command
  try {
    command = JSON.parse(raw)
  } catch (error) {
    console.error(`OPERATOR_MCP_UPSTREAM_COMMAND must be valid JSON: ${error.message}`)
    process.exit(64)
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    console.error("OPERATOR_MCP_UPSTREAM_COMMAND must be a non-empty JSON string array")
    process.exit(64)
  }
  return command
}

function allowedTools() {
  const raw = process.env.OPERATOR_MCP_ALLOWED_TOOLS || "[]"
  let tools
  try {
    tools = JSON.parse(raw)
  } catch (error) {
    console.error(`OPERATOR_MCP_ALLOWED_TOOLS must be a JSON array: ${error.message}`)
    process.exit(64)
  }
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    console.error("OPERATOR_MCP_ALLOWED_TOOLS must be a JSON string array")
    process.exit(64)
  }
  return new Set(tools)
}

const command = commandFromEnvironment()
const toolAllowlist = allowedTools()
const maxPages = positiveInteger("OPERATOR_MCP_MAX_RESOURCE_PAGES", 100)
const maxResources = positiveInteger("OPERATOR_MCP_MAX_RESOURCES", 10_000)
const maxLineBytes = positiveInteger("OPERATOR_MCP_MAX_MESSAGE_BYTES", 8 * 1024 * 1024)
const pending = new Map()
let resourceSequence = { pages: 0, resources: 0 }
let shuttingDown = false

function send(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`)
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

function parseLine(line, direction) {
  if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
    throw new Error(`${direction} MCP message exceeds ${maxLineBytes} bytes`)
  }
  return JSON.parse(line)
}

function hasSandboxStateMeta(value) {
  if (!value || typeof value !== "object") return false
  const stack = [value]
  const seen = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    for (const [key, child] of Object.entries(current)) {
      if (key === "codex/sandbox-state-meta") return true
      if (child && typeof child === "object") stack.push(child)
    }
  }
  return false
}

const upstream = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
  shell: false,
})

upstream.on("error", (error) => {
  console.error(`Unable to start guarded MCP server: ${error.message}`)
  process.exitCode = 69
})

upstream.on("close", (code, signal) => {
  shuttingDown = true
  if (signal) console.error(`Guarded MCP server terminated by ${signal}`)
  process.exit(code ?? 69)
})

const clientInput = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
clientInput.on("line", (line) => {
  if (line.trim() === "") return
  let message
  try {
    message = parseLine(line, "client-to-server")
  } catch (error) {
    console.error(`Rejected malformed MCP client message: ${error.message}`)
    return
  }

  if (message.method === "resources/list" && message.id !== undefined) {
    const cursor = message.params?.cursor
    if (cursor === undefined || cursor === null || cursor === "") resourceSequence = { pages: 0, resources: 0 }
    resourceSequence.pages += 1
    const page = resourceSequence.pages
    if (page > maxPages) {
      send(process.stdout, errorResponse(message.id, -32061, "MCP resource pagination page limit exceeded", {
        max_pages: maxPages,
      }))
      return
    }
    pending.set(String(message.id), { method: "resources/list", page })
  }

  if (message.method === "tools/call" && message.id !== undefined) {
    const tool = message.params?.name
    if (typeof tool !== "string" || !toolAllowlist.has(tool)) {
      send(process.stdout, errorResponse(message.id, -32062, "MCP tool is not on the explicit operator allowlist", {
        tool: typeof tool === "string" ? tool : null,
      }))
      return
    }
    pending.set(String(message.id), { method: "tools/call", tool })
  }

  upstream.stdin.write(`${line}\n`)
})

clientInput.on("close", () => {
  if (!shuttingDown) upstream.stdin.end()
})

const upstreamOutput = readline.createInterface({ input: upstream.stdout, crlfDelay: Infinity })
upstreamOutput.on("line", (line) => {
  if (line.trim() === "") return
  let message
  try {
    message = parseLine(line, "server-to-client")
  } catch (error) {
    console.error(`Guarded MCP server emitted malformed JSON: ${error.message}`)
    return
  }

  const record = message.id === undefined ? undefined : pending.get(String(message.id))
  if (!record) {
    send(process.stdout, message)
    return
  }
  pending.delete(String(message.id))

  if (record.method === "resources/list" && message.result) {
    const resources = Array.isArray(message.result.resources) ? message.result.resources.length : 0
    resourceSequence.resources += resources
    if (resourceSequence.resources > maxResources) {
      send(process.stdout, errorResponse(message.id, -32063, "MCP resource count limit exceeded", {
        max_resources: maxResources,
      }))
      return
    }
    if (message.result.nextCursor && record.page >= maxPages) {
      send(process.stdout, errorResponse(message.id, -32061, "MCP resource pagination did not terminate within the approved limit", {
        max_pages: maxPages,
      }))
      return
    }
  }

  if (record.method === "tools/call" && message.result && hasSandboxStateMeta(message.result)) {
    send(process.stdout, errorResponse(message.id, -32064, "MCP tool result attempted to carry sandbox-state authority", {
      tool: record.tool,
    }))
    return
  }

  send(process.stdout, message)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    upstream.kill(signal)
  })
}
