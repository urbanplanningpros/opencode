import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-mcp-file-upload-environment-guard.mjs")
const fixCommit = "250de82bfb51a210325e88bfe1f7c30b0fa514f0"
const hashA = "a".repeat(64)
const hashB = "b".repeat(64)
const hashC = "c".repeat(64)
const hashD = "d".repeat(64)

function baseReceipt() {
  return {
    admission: "production",
    runtime: {
      version: "0.146.0",
      fixed_step_context: false,
      fix_reference: null,
      production_fix_validated: false,
    },
    route: {
      provider: "openai",
      transport: "direct",
      auth_mode: "chatgpt",
    },
    operation_id: "mcp-file-read-001",
    idempotency_key: "mcp-file-read-001-v1",
    task: {
      mode: "read",
      tool: "read_uploaded_file",
      arguments_sha256: hashA,
    },
    environment: {
      expected_id: "vps-primary",
      turn_state: "ready",
      turn_primary_id: "vps-primary",
      step_state: "ready",
      step_primary_id: "vps-primary",
      became_ready_during_turn: false,
      step_context_refreshed: true,
      capability_roots_sha256: hashB,
    },
    files: [
      {
        field: "file",
        path_uri: "file:///approved/report.pdf",
        resolved_environment_id: "vps-primary",
        approved_root_id: "operator-uploads",
        approved_root_sha256: hashC,
        content_sha256: hashD,
        regular_file: true,
        symlink: false,
      },
    ],
  }
}

function run(receipt) {
  return spawnSync(process.execPath, [guard, "--json"], {
    input: JSON.stringify(receipt),
    encoding: "utf8",
    timeout: 10000,
  })
}

const staticReady = run(baseReceipt())
assert.equal(staticReady.status, 0, staticReady.stderr)
assert.equal(JSON.parse(staticReady.stdout).allowed, true)

const dynamicStable = baseReceipt()
dynamicStable.environment.turn_state = "starting"
dynamicStable.environment.turn_primary_id = null
dynamicStable.environment.became_ready_during_turn = true
const dynamicStableResult = run(dynamicStable)
assert.equal(dynamicStableResult.status, 75)
assert.match(dynamicStableResult.stdout, /stale turn snapshot/)

const fixedCanary = structuredClone(dynamicStable)
fixedCanary.admission = "canary"
fixedCanary.runtime.version = "0.146.1-canary"
fixedCanary.runtime.fixed_step_context = true
fixedCanary.runtime.fix_reference = fixCommit
const fixedCanaryResult = run(fixedCanary)
assert.equal(fixedCanaryResult.status, 0, fixedCanaryResult.stderr)

const fixedProductionUnvalidated = structuredClone(fixedCanary)
fixedProductionUnvalidated.admission = "production"
const fixedProductionResult = run(fixedProductionUnvalidated)
assert.equal(fixedProductionResult.status, 75)
assert.match(fixedProductionResult.stdout, /canary-only/)

const staleStep = baseReceipt()
staleStep.environment.step_state = "starting"
staleStep.environment.step_context_refreshed = false
const staleStepResult = run(staleStep)
assert.equal(staleStepResult.status, 75)
assert.match(staleStepResult.stdout, /current step/)

const wrongEnvironment = baseReceipt()
wrongEnvironment.files[0].resolved_environment_id = "other-environment"
const wrongEnvironmentResult = run(wrongEnvironment)
assert.equal(wrongEnvironmentResult.status, 64)
assert.match(wrongEnvironmentResult.stdout, /resolved_environment_id/)

const symlinkedFile = baseReceipt()
symlinkedFile.files[0].symlink = true
const symlinkedFileResult = run(symlinkedFile)
assert.equal(symlinkedFileResult.status, 64)
assert.match(symlinkedFileResult.stdout, /symlink must be false/)

const prohibitedRoute = baseReceipt()
prohibitedRoute.route.provider = "provider-gateway"
const prohibitedRouteResult = run(prohibitedRoute)
assert.equal(prohibitedRouteResult.status, 64)
assert.match(prohibitedRouteResult.stdout, /excluded provider/)

const writeWithoutVerification = baseReceipt()
writeWithoutVerification.task = {
  mode: "write",
  tool: "send_file",
  arguments_sha256: hashA,
}
const writeWithoutVerificationResult = run(writeWithoutVerification)
assert.equal(writeWithoutVerificationResult.status, 64)
assert.match(writeWithoutVerificationResult.stdout, /independent verification plan/)

const verifiedWrite = structuredClone(writeWithoutVerification)
verifiedWrite.task.verification = {
  tool: "verify_file_destination",
  expected_sha256: hashB,
  destination_read_required: true,
}
const verifiedWriteResult = run(verifiedWrite)
assert.equal(verifiedWriteResult.status, 0, verifiedWriteResult.stderr)

console.log("Codex MCP file-upload environment guard self-test passed")
