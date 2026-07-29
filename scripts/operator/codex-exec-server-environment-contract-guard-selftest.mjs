#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exec-environment-contract-"))
const guard = new URL("./codex-exec-server-environment-contract-guard.mjs", import.meta.url)
const hash = "a".repeat(64)

function run(name, evidence) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  const result = spawnSync(process.execPath, [guard.pathname, "--input", file, "--json"], {
    encoding: "utf8",
  })
  let output = null
  try {
    output = JSON.parse(result.stdout)
  } catch {}
  return { ...result, output }
}

const base = {
  task_id: "task-1",
  operation_id: "operation-1",
  environment_id: "environment-1",
  bridge_identity_sha256: hash,
  route: "local",
  requires_explicit_shell: true,
  process_start_dispatched: true,
  host_retained_process_start: true,
  codex_rollout_retained_process_start: true,
  path_uri_treated_as_uri: true,
  environment_info: {
    method: "environment/info",
    requested: true,
    observed_before_process_start: true,
    status: "success",
    shell: { name: "bash", path: "/bin/bash" },
    cwd_uri: "file:///workspace",
  },
}

const valid = run("valid", base)
assert.equal(valid.status, 0, valid.stderr || valid.stdout)
assert.equal(valid.output?.admitted, true)

const missingInfo = run("missing-info", {
  ...base,
  process_start_dispatched: false,
  host_retained_process_start: false,
  codex_rollout_retained_process_start: false,
  host_retained_predispatch_failure: true,
  codex_rollout_retained_predispatch_failure: true,
  environment_info: {
    method: "environment/info",
    requested: true,
    observed_before_process_start: true,
    status: "method_not_found",
  },
})
assert.equal(missingInfo.status, 75, missingInfo.stderr || missingInfo.stdout)
assert.equal(missingInfo.output?.admitted, false)

const invisibleFailure = run("invisible-failure", {
  ...base,
  process_start_dispatched: false,
  host_retained_process_start: false,
  codex_rollout_retained_process_start: false,
  host_retained_predispatch_failure: false,
  codex_rollout_retained_predispatch_failure: true,
  environment_info: {
    method: "environment/info",
    requested: true,
    observed_before_process_start: true,
    status: "method_not_found",
  },
})
assert.equal(invisibleFailure.status, 64, invisibleFailure.stderr || invisibleFailure.stdout)

const malformedPathUri = run("malformed-path-uri", {
  ...base,
  environment_info: {
    ...base.environment_info,
    cwd_uri: "/workspace/file:/workspace",
  },
})
assert.equal(malformedPathUri.status, 64, malformedPathUri.stderr || malformedPathUri.stdout)

const earlyDispatch = run("early-dispatch", {
  ...base,
  environment_info: {
    ...base.environment_info,
    status: "method_not_found",
    shell: undefined,
    cwd_uri: undefined,
  },
})
assert.equal(earlyDispatch.status, 64, earlyDispatch.stderr || earlyDispatch.stdout)

const prohibited = run("prohibited", {
  ...base,
  bridge_label: "automatic gateway selector",
})
assert.equal(prohibited.status, 64, prohibited.stderr || prohibited.stdout)

fs.rmSync(root, { recursive: true, force: true })
console.log("codex exec-server environment contract guard self-test passed")
