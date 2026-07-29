import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-exec-server-lifecycle-guard.mjs")
const executable = path.resolve("/approved/bin/codex")

function run(plan) {
  return spawnSync(process.execPath, [guard, "--json"], {
    input: JSON.stringify(plan),
    encoding: "utf8",
    timeout: 10000,
  })
}

const parentOwned = {
  mode: "parent_owned",
  route: "direct_openai",
  transport: "stdio",
  stdin: "pipe",
  detached: false,
  command: [executable, "exec-server", "--remote", "--exit-on-stdin-close"],
  env: {},
  shutdown: {
    graceful_drain: true,
    terminate_owned_children: true,
    flush_telemetry: true,
  },
  child_environment: {
    inherits_parent_lifetime_control: false,
  },
}

const parentResult = run(parentOwned)
assert.equal(parentResult.status, 0, parentResult.stderr)
assert.equal(JSON.parse(parentResult.stdout).normalized.exit_on_stdin_close, true)

const missingPipe = structuredClone(parentOwned)
missingPipe.stdin = "inherit"
const missingPipeResult = run(missingPipe)
assert.equal(missingPipeResult.status, 64)
assert.match(missingPipeResult.stdout, /stdin='pipe'/)

const missingLifetime = structuredClone(parentOwned)
missingLifetime.command = [executable, "exec-server", "--remote"]
const missingLifetimeResult = run(missingLifetime)
assert.equal(missingLifetimeResult.status, 64)
assert.match(missingLifetimeResult.stdout, /exit-on-stdin-close/)

const envLifetime = structuredClone(missingLifetime)
envLifetime.env.CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE = "1"
const envLifetimeResult = run(envLifetime)
assert.equal(envLifetimeResult.status, 0, envLifetimeResult.stderr)

const standalone = {
  mode: "standalone",
  route: "authorized_local",
  transport: "stdio",
  stdin: "null",
  detached: true,
  command: [executable, "exec-server", "--remote"],
  env: { CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE: "0" },
  supervision: {
    pid_file: path.resolve("/approved/run/codex-exec-server.pid"),
    healthcheck: "GET http://127.0.0.1:4500/health",
    shutdown_timeout_seconds: 30,
  },
}

const standaloneResult = run(standalone)
assert.equal(standaloneResult.status, 0, standaloneResult.stderr)

const accidentalParentLifetime = structuredClone(standalone)
accidentalParentLifetime.env.CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE = "1"
const accidentalParentLifetimeResult = run(accidentalParentLifetime)
assert.equal(accidentalParentLifetimeResult.status, 64)
assert.match(accidentalParentLifetimeResult.stdout, /must not enable/)

const prohibitedRoute = structuredClone(parentOwned)
prohibitedRoute.route = "provider-gateway"
const prohibitedRouteResult = run(prohibitedRoute)
assert.equal(prohibitedRouteResult.status, 64)
assert.match(prohibitedRouteResult.stdout, /excluded provider/)

console.log("Codex exec-server lifecycle guard self-test passed")
