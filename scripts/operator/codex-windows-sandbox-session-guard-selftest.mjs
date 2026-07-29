import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-sandbox-session-"))
const guard = path.resolve("scripts/operator/codex-windows-sandbox-session-guard.mjs")

function writeEvidence(name, payload) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  return file
}

function run(name, payload, extraArgs = [], env = {}) {
  const evidence = writeEvidence(name, payload)
  const result = spawnSync(process.execPath, [guard, "--evidence", evidence, "--json", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  const text = String(result.stdout || result.stderr || "").trim()
  return { status: result.status, output: text ? JSON.parse(text) : null }
}

try {
  const blockedDirect = run("blocked-direct", {
    platform: "win32",
    operation: "codex_sandbox",
    codex_version: "0.146.0",
    codex_sandbox_logon_sessions: 0,
    baseline_codex_sandbox_logon_sessions: 0,
    lsass_handles: 2800,
    session_probe_complete: true,
  })
  assert.equal(blockedDirect.status, 75)
  assert.equal(blockedDirect.output.reason, "codex_sandbox_session_leak_unfixed")

  const boundedExec = run("bounded-exec", {
    platform: "win32",
    operation: "codex_exec",
    codex_version: "0.146.0",
    codex_sandbox_logon_sessions: 12,
    baseline_codex_sandbox_logon_sessions: 12,
    lsass_handles: 3200,
    session_probe_complete: true,
  })
  assert.equal(boundedExec.status, 0)
  assert.equal(boundedExec.output.reason, "windows_session_state_bounded")

  const growth = run("growth", {
    platform: "win32",
    operation: "codex_exec",
    codex_version: "0.146.0",
    codex_sandbox_logon_sessions: 120,
    baseline_codex_sandbox_logon_sessions: 110,
    lsass_handles: 4900,
    session_probe_complete: true,
  })
  assert.equal(growth.status, 75)
  assert.equal(growth.output.reason, "windows_sandbox_session_growth_detected")

  const fixed = run("fixed", {
    platform: "win32",
    operation: "codex_sandbox",
    codex_version: "0.147.1",
    codex_sandbox_logon_sessions: 20,
    baseline_codex_sandbox_logon_sessions: 20,
    lsass_handles: 3400,
    session_probe_complete: true,
    release_fix_attested: true,
    canary_invocations: 500,
    canary_session_delta: 0,
    network_denial_passed: true,
    piped_spawn_passed: true,
  })
  assert.equal(fixed.status, 0)
  assert.equal(fixed.output.fixed_build_canary_passed, true)

  const prohibited = run(
    "prohibited",
    {
      platform: "win32",
      operation: "codex_exec",
      codex_sandbox_logon_sessions: 0,
      baseline_codex_sandbox_logon_sessions: 0,
      lsass_handles: 2500,
      session_probe_complete: true,
    },
    [],
    { OPERATOR_ROUTE: "model-gateway-auto-select" },
  )
  assert.equal(prohibited.status, 64)
  assert.equal(prohibited.output.reason, "prohibited_route_metadata")

  console.log("codex-windows-sandbox-session-guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
