import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"

const guard = path.resolve(new URL("./codex-windows-update-integrity-guard.mjs", import.meta.url).pathname)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-guard-"))
const digestA = "a".repeat(64)
const digestB = "b".repeat(64)

function run(name, evidence) {
  const input = path.join(tmp, `${name}.json`)
  fs.writeFileSync(input, JSON.stringify(evidence, null, 2))
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  const body = JSON.parse(result.stdout || result.stderr)
  return { ...result, body }
}

const base = {
  operation_id: "op-update-001",
  platform: "Windows 11 x64",
  current_version: "0.145.0",
  target_version: "0.146.0",
  update_method: "codex_update",
  installer_url: "https://chatgpt.com/codex/install.ps1",
  observed_installer_sha256: digestA,
  expected_installer_sha256: digestA,
  updater_blocked: false,
  script_contained_malicious_content: false,
  antivirus_detection_recorded: false,
  antivirus_disabled_or_bypassed: false,
  unsupported_allowlist_added: false,
  self_update_retry_suppressed: false,
  package_manifest_verified: false,
  package_digest_verified: false,
  staged_version_directory: false,
  atomic_current_switch: false,
  rollback_target_preserved: false,
  installed_version_verified: false,
  current_version_still_usable: true,
  fallback_route: "none",
}

let result = run("healthy", base)
assert.equal(result.status, 0)
assert.equal(result.body.admitted, true)

result = run("blocked-no-fallback", {
  ...base,
  updater_blocked: true,
  script_contained_malicious_content: true,
  antivirus_detection_recorded: true,
  self_update_retry_suppressed: true,
})
assert.equal(result.status, 75)
assert.equal(result.body.reason, "safe_update_fallback_required")

result = run("blocked-continue-current", {
  ...base,
  updater_blocked: true,
  script_contained_malicious_content: true,
  antivirus_detection_recorded: true,
  self_update_retry_suppressed: true,
  fallback_route: "continue_pinned_current",
})
assert.equal(result.status, 0)
assert.equal(result.body.reason, "windows_self_update_isolated_current_version_continues")

result = run("blocked-direct-package", {
  ...base,
  updater_blocked: true,
  script_contained_malicious_content: true,
  antivirus_detection_recorded: true,
  self_update_retry_suppressed: true,
  update_method: "verified_direct_package",
  package_url: "https://releases.openai.com/codex/codex-package-x86_64-pc-windows-msvc.tar.gz",
  manifest_url: "https://releases.openai.com/codex/codex-package_SHA256SUMS",
  observed_package_sha256: digestB,
  expected_package_sha256: digestB,
  package_manifest_verified: true,
  package_digest_verified: true,
  staged_version_directory: true,
  atomic_current_switch: true,
  rollback_target_preserved: true,
  installed_version_verified: true,
  fallback_route: "verified_direct_package",
})
assert.equal(result.status, 0)
assert.equal(result.body.reason, "windows_update_rerouted_to_verified_direct_package")

result = run("digest-mismatch", {
  ...base,
  observed_installer_sha256: digestA,
  expected_installer_sha256: digestB,
})
assert.equal(result.status, 65)
assert.equal(result.body.reason, "installer_digest_mismatch")

result = run("disable-antivirus", {
  ...base,
  updater_blocked: true,
  script_contained_malicious_content: true,
  antivirus_disabled_or_bypassed: true,
  fallback_route: "continue_pinned_current",
})
assert.equal(result.status, 64)
assert.equal(result.body.reason, "antivirus_bypass_forbidden")

result = run("unofficial-package", {
  ...base,
  updater_blocked: true,
  script_contained_malicious_content: true,
  antivirus_detection_recorded: true,
  self_update_retry_suppressed: true,
  update_method: "verified_direct_package",
  package_url: "https://example.com/codex.tar.gz",
  manifest_url: "https://releases.openai.com/codex/codex-package_SHA256SUMS",
  observed_package_sha256: digestB,
  expected_package_sha256: digestB,
  package_manifest_verified: true,
  package_digest_verified: true,
  staged_version_directory: true,
  atomic_current_switch: true,
  rollback_target_preserved: true,
  installed_version_verified: true,
  fallback_route: "verified_direct_package",
})
assert.equal(result.status, 64)
assert.equal(result.body.reason, "official_release_package_and_manifest_required")

result = run("prohibited-route", {
  ...base,
  fallback_route: "gateway-auto-select",
})
assert.equal(result.status, 64)
assert.equal(result.body.reason, "prohibited_route_metadata")

fs.rmSync(tmp, { recursive: true, force: true })
console.log("codex-windows-update-integrity-guard self-test passed")
