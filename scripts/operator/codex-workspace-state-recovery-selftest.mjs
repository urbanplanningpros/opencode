import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const workspaceGuard = path.join(root, "scripts/operator/codex-windows-workspace-filesystem-guard.mjs")
const stateGuard = path.join(root, "scripts/operator/codex-state-recovery-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-state-guard-"))

function writeJson(name, value) {
  const file = path.join(temp, name)
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  return file
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function run(script, args, expectedStatus, expectedText) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", shell: false })
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`
  if (result.status !== expectedStatus || !combined.includes(expectedText)) {
    throw new Error(
      `Unexpected result for ${path.basename(script)}\nexpected status=${expectedStatus} text=${expectedText}\nactual status=${result.status}\n${combined}`,
    )
  }
}

try {
  const localEvidence = writeJson("local-fs.json", {
    drive_type: 3,
    file_system: "NTFS",
    provider: "FileSystem",
    sandbox_error: null,
  })
  run(workspaceGuard, ["--workspace", temp, "--evidence", localEvidence, "--json"], 0, "local_acl_capable_workspace")

  const virtualEvidence = writeJson("virtual-fs.json", {
    drive_type: 3,
    file_system: null,
    provider: "FileSystem",
    sandbox_error: "SetNamedSecurityInfoW failed: 87",
  })
  run(workspaceGuard, ["--workspace", temp, "--evidence", virtualEvidence, "--json"], 75, "windows_sandbox_acl_failure")

  const artifact = path.join(temp, "findings.json")
  fs.writeFileSync(artifact, '{"findings":21}\n')
  const artifactSha = sha256(artifact)
  const snapshotA = "a".repeat(64)
  const snapshotB = "b".repeat(64)

  const recoverableScan = writeJson("recoverable-scan.json", {
    mode: "security_scan_finalization",
    operation_id: "scan-001",
    idempotency_key: "scan-001-finalize",
    provider: "openai",
    route: "direct",
    discovery_complete: true,
    validation_complete: true,
    writeups_complete: true,
    artifacts_complete: true,
    canonical_artifacts: [{ path: artifact, sha256: artifactSha }],
    expected_snapshot_sha256: snapshotA,
    current_snapshot_sha256: snapshotB,
    continuation_owner_valid: false,
  })
  run(stateGuard, ["--input", recoverableScan, "--json"], 75, "restore_or_rebind_snapshot_then_adopt_artifacts")

  const finalizableScan = writeJson("finalizable-scan.json", {
    mode: "security_scan_finalization",
    operation_id: "scan-002",
    idempotency_key: "scan-002-finalize",
    provider: "openai",
    route: "direct",
    discovery_complete: true,
    validation_complete: true,
    writeups_complete: true,
    artifacts_complete: true,
    canonical_artifacts: [{ path: artifact, sha256: artifactSha }],
    expected_snapshot_sha256: snapshotA,
    current_snapshot_sha256: snapshotA,
    continuation_owner_valid: true,
  })
  run(stateGuard, ["--input", finalizableScan, "--json"], 0, "finalize_existing_artifacts_once")

  const compaction = writeJson("compaction.json", {
    mode: "compaction_capacity",
    operation_id: "task-003",
    idempotency_key: "task-003-compact",
    provider: "openai",
    route: "direct",
    selected_model: "gpt-5.6-sol",
    allow_automatic_model_change: false,
    error: "Error running remote compact task: Selected model is at capacity.",
    task_state_checkpointed: true,
    pending_writes_reconciled: true,
    failure_count: 1,
  })
  run(stateGuard, ["--input", compaction, "--json"], 75, "retry_same_model_once_after_jitter")

  const prohibited = writeJson("prohibited.json", {
    mode: "compaction_capacity",
    operation_id: "task-004",
    idempotency_key: "task-004-compact",
    provider: "openai",
    route: "automatic gateway",
    selected_model: "gpt-5.6-sol",
    error: "Selected model is at capacity.",
    task_state_checkpointed: true,
    pending_writes_reconciled: true,
  })
  run(stateGuard, ["--input", prohibited, "--json"], 64, "prohibited_route_metadata")

  console.log("Codex workspace and state recovery guards self-test passed")
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
