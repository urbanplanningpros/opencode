#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./codex-command-evidence.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-command-evidence-"))

function run(operationId, command, timeoutSeconds, expectedStatus) {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--operation-id",
      operationId,
      "--idempotency-key",
      `${operationId}-v1`,
      "--evidence-root",
      root,
      "--timeout-seconds",
      String(timeoutSeconds),
      "--",
      ...command,
    ],
    {
      encoding: "utf8",
      timeout: (timeoutSeconds + 8) * 1000,
      windowsHide: true,
    },
  )
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

try {
  const completed = run(
    "completed-read",
    [process.execPath, "-e", "console.log('stdout-complete'); console.error('stderr-complete')"],
    10,
    0,
  )
  assert.match(completed.stdout, /stdout-complete/)
  assert.match(completed.stderr, /stderr-complete/)

  const completedDir = path.join(root, "completed-read")
  const completedReceipt = JSON.parse(fs.readFileSync(path.join(completedDir, "receipt.json"), "utf8"))
  assert.equal(completedReceipt.status, "completed")
  assert.equal(completedReceipt.exit_code, 0)
  assert.equal(completedReceipt.partial_output_preserved, false)
  assert.equal(completedReceipt.safe_to_infer_external_write_completion, false)
  assert.match(fs.readFileSync(path.join(completedDir, "stdout.log"), "utf8"), /stdout-complete/)
  assert.match(fs.readFileSync(path.join(completedDir, "stderr.log"), "utf8"), /stderr-complete/)
  assert.match(completedReceipt.stdout_sha256, /^[a-f0-9]{64}$/)
  assert.match(completedReceipt.stderr_sha256, /^[a-f0-9]{64}$/)

  const timedOut = run(
    "timed-out-read",
    [
      process.execPath,
      "-e",
      "console.log('partial-before-timeout'); console.error('partial-error-before-timeout'); setInterval(() => {}, 1000)",
    ],
    1,
    124,
  )
  assert.match(timedOut.stdout, /partial-before-timeout/)

  const timeoutDir = path.join(root, "timed-out-read")
  const timeoutReceipt = JSON.parse(fs.readFileSync(path.join(timeoutDir, "receipt.json"), "utf8"))
  assert.equal(timeoutReceipt.status, "timeout")
  assert.equal(timeoutReceipt.partial_output_preserved, true)
  assert.equal(timeoutReceipt.safe_to_infer_external_write_completion, false)
  assert.match(fs.readFileSync(path.join(timeoutDir, "stdout.log"), "utf8"), /partial-before-timeout/)
  assert.match(fs.readFileSync(path.join(timeoutDir, "stderr.log"), "utf8"), /partial-error-before-timeout/)

  const duplicate = run(
    "completed-read",
    [process.execPath, "-e", "console.log('must-not-run')"],
    10,
    75,
  )
  assert.doesNotMatch(duplicate.stdout, /must-not-run/)
  assert.match(duplicate.stderr, /evidence already exists/)

  console.log("Codex command evidence self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
