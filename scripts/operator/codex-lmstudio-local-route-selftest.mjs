import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, "codex-lmstudio-local-route.mjs")
const model = "openai/gpt-oss-20b"

function run(args, { env = {}, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        OPERATOR_LMSTUDIO_ALLOWED_MODELS: JSON.stringify([model]),
        OPERATOR_LMSTUDIO_MODEL: model,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
    child.stdin.end(input)
  })
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }))
    return
  }

  if (request.method === "POST" && request.url === "/v1/responses") {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert.equal(body.model, model)
      assert.equal(body.stream, false)
      assert.equal(body.store, false)
      assert.deepEqual(body.tools, [])
      assert.equal(body.max_output_tokens, 8192)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: "resp_local_test",
          output: [{ type: "message", content: [{ type: "output_text", text: "LOCAL_ROUTE_OK" }] }],
        }),
      )
    })
    return
  }

  response.writeHead(404, { "content-type": "application/json" })
  response.end(JSON.stringify({ error: "not found" }))
})

await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})

try {
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`

  const probe = await run(["--probe", "--json"], { env: { OPERATOR_LMSTUDIO_BASE_URL: base } })
  assert.equal(probe.code, 75, probe.stderr)
  const report = JSON.parse(probe.stdout)
  assert.equal(report.status, "direct_local_required")
  assert.equal(report.catalog_shape, "openai_data")
  assert.equal(report.codex_oss_safe, false)

  const execute = await run(["--execute"], {
    env: { OPERATOR_LMSTUDIO_BASE_URL: base },
    input: "Return the continuity marker.",
  })
  assert.equal(execute.code, 0, execute.stderr)
  assert.equal(execute.stdout.trim(), "LOCAL_ROUTE_OK")

  const canary = await run(["--canary", "--json"], { env: { OPERATOR_LMSTUDIO_BASE_URL: base } })
  assert.equal(canary.code, 0, canary.stderr)
  assert.equal(JSON.parse(canary.stdout).status, "verified")

  const remote = await run(["--probe"], { env: { OPERATOR_LMSTUDIO_BASE_URL: "http://example.com:1234" } })
  assert.equal(remote.code, 64)
  assert.match(remote.stderr, /non-loopback/)

  const prohibited = await run(["--probe"], {
    env: {
      OPERATOR_LMSTUDIO_BASE_URL: base,
      OPERATOR_LMSTUDIO_MODEL: "claude-local",
      OPERATOR_LMSTUDIO_ALLOWED_MODELS: JSON.stringify(["claude-local"]),
    },
  })
  assert.equal(prohibited.code, 64)
  assert.match(prohibited.stderr, /prohibited/)

  console.log("LM Studio local continuity self-test passed")
} finally {
  await new Promise((resolve) => server.close(resolve))
}
