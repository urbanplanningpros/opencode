import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dynamic-tool-guard-"))
const guard = path.resolve("scripts/operator/codex-dynamic-tool-subscriber-guard.mjs")

function run(name, evidence, expectedExit) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedExit) {
    console.error(`${name}: expected exit ${expectedExit}, received ${result.status}`)
    console.error(result.stdout)
    console.error(result.stderr)
    process.exit(1)
  }
  return result.stdout ? JSON.parse(result.stdout) : null
}

const base = {
  thread_id: "thread-1",
  request_id: "request-1",
  tool_name: "upp.sessions_create",
  mutating: true,
  operation_id: "operation-1",
  idempotency_key: "session-create-1",
  independent_verification_planned: true,
  durable_side_effect: "none",
  retry_requested: false,
  subscribers: [
    {
      connection_id: "connection-owner",
      dynamic_tool_handler: true,
      authorized: true,
      response_authority: true,
    },
  ],
  exclusive_thread_lease: true,
}

const admitted = run("single-subscriber", base, 0)
if (admitted?.dispatch_mode !== "exclusive_single_subscriber") process.exit(1)

run(
  "broadcast-race",
  {
    ...base,
    exclusive_thread_lease: false,
    subscribers: [
      base.subscribers[0],
      {
        connection_id: "desktop-observer",
        dynamic_tool_handler: false,
        authorized: false,
        response_authority: true,
      },
    ],
  },
  75,
)

run(
  "targeted-patched-server",
  {
    ...base,
    exclusive_thread_lease: false,
    targeted_dispatch: true,
    target_connection_id: "connection-owner",
    callback_bound_to_connection: true,
    response_connection_id: "connection-owner",
    subscribers: [
      base.subscribers[0],
      {
        connection_id: "desktop-observer",
        dynamic_tool_handler: false,
        authorized: false,
        response_authority: false,
      },
    ],
  },
  0,
)

run(
  "uncertain-retry",
  {
    ...base,
    caller_visible_result: "failure",
    durable_side_effect: "present",
    retry_requested: true,
  },
  75,
)

run(
  "prohibited-route",
  {
    ...base,
    route: "automatic-gateway",
  },
  64,
)

fs.rmSync(root, { recursive: true, force: true })
console.log("codex dynamic-tool subscriber guard self-test passed")
