import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJson(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("evidence must be a regular non-symlink file")
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function text(value, name, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return ""
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function normalizeSha256(value, name, optional = false) {
  const normalized = text(value, name, optional).toLowerCase()
  if (!normalized && optional) return ""
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${name} must be a 64-character SHA-256 digest`)
  }
  return normalized
}

function isOfficialReleaseUrl(value) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "releases.openai.com"
  } catch {
    return false
  }
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJson(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
if (prohibited.test(JSON.stringify({ evidence, provider: args.provider, route: args.route, env: process.env.OPERATOR_ROUTE }))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let platform
let currentVersion
let targetVersion
let updateMethod
let installerUrl
let packageUrl
let manifestUrl
let observedInstallerSha256
let expectedInstallerSha256
let observedPackageSha256
let expectedPackageSha256
let fallbackRoute
try {
  operationId = text(evidence.operation_id, "operation_id")
  platform = text(evidence.platform, "platform").toLowerCase()
  currentVersion = text(evidence.current_version, "current_version")
  targetVersion = text(evidence.target_version, "target_version")
  updateMethod = text(evidence.update_method, "update_method").toLowerCase()
  installerUrl = text(evidence.installer_url, "installer_url", true)
  packageUrl = text(evidence.package_url, "package_url", true)
  manifestUrl = text(evidence.manifest_url, "manifest_url", true)
  observedInstallerSha256 = normalizeSha256(evidence.observed_installer_sha256, "observed_installer_sha256", true)
  expectedInstallerSha256 = normalizeSha256(evidence.expected_installer_sha256, "expected_installer_sha256", true)
  observedPackageSha256 = normalizeSha256(evidence.observed_package_sha256, "observed_package_sha256", true)
  expectedPackageSha256 = normalizeSha256(evidence.expected_package_sha256, "expected_package_sha256", true)
  fallbackRoute = text(evidence.fallback_route, "fallback_route", true).toLowerCase()
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const windows = platform.includes("windows")
const updaterBlocked = bool(evidence.updater_blocked, "updater_blocked")
const scriptContainedMaliciousContent = bool(
  evidence.script_contained_malicious_content,
  "script_contained_malicious_content",
)
const antivirusDetectionRecorded = bool(evidence.antivirus_detection_recorded, "antivirus_detection_recorded")
const antivirusDisabledOrBypassed = bool(evidence.antivirus_disabled_or_bypassed, "antivirus_disabled_or_bypassed")
const unsupportedAllowlistAdded = bool(evidence.unsupported_allowlist_added, "unsupported_allowlist_added")
const selfUpdateRetrySuppressed = bool(evidence.self_update_retry_suppressed, "self_update_retry_suppressed")
const packageManifestVerified = bool(evidence.package_manifest_verified, "package_manifest_verified")
const packageDigestVerified = bool(evidence.package_digest_verified, "package_digest_verified")
const stagedVersionDirectory = bool(evidence.staged_version_directory, "staged_version_directory")
const atomicCurrentSwitch = bool(evidence.atomic_current_switch, "atomic_current_switch")
const rollbackTargetPreserved = bool(evidence.rollback_target_preserved, "rollback_target_preserved")
const installedVersionVerified = bool(evidence.installed_version_verified, "installed_version_verified")
const currentVersionStillUsable = bool(evidence.current_version_still_usable, "current_version_still_usable")
const installerDigestMatches =
  Boolean(observedInstallerSha256) &&
  Boolean(expectedInstallerSha256) &&
  observedInstallerSha256 === expectedInstallerSha256
const packageDigestMatches =
  Boolean(observedPackageSha256) &&
  Boolean(expectedPackageSha256) &&
  observedPackageSha256 === expectedPackageSha256
const officialInstaller = !installerUrl || installerUrl === "https://chatgpt.com/codex/install.ps1"
const officialPackage = isOfficialReleaseUrl(packageUrl)
const officialManifest = isOfficialReleaseUrl(manifestUrl)
const supportedUpdateMethods = new Set(["codex_update", "verified_direct_package"])
const approvedFallbackRoutes = new Set(["none", "verified_direct_package", "continue_pinned_current"])
const avBlockedUpdate = windows && updaterBlocked && scriptContainedMaliciousContent

let admitted = true
let reason = "windows_update_path_verified"
let exitCode = 0

if (!supportedUpdateMethods.has(updateMethod)) {
  admitted = false
  reason = "unsupported_update_method"
  exitCode = 64
} else if (!approvedFallbackRoutes.has(fallbackRoute || "none")) {
  admitted = false
  reason = "unapproved_update_fallback"
  exitCode = 64
} else if (antivirusDisabledOrBypassed || unsupportedAllowlistAdded) {
  admitted = false
  reason = "antivirus_bypass_forbidden"
  exitCode = 64
} else if (!officialInstaller) {
  admitted = false
  reason = "unofficial_installer_source"
  exitCode = 64
} else if (observedInstallerSha256 && expectedInstallerSha256 && !installerDigestMatches) {
  admitted = false
  reason = "installer_digest_mismatch"
  exitCode = 65
} else if (avBlockedUpdate && !antivirusDetectionRecorded) {
  admitted = false
  reason = "antivirus_detection_receipt_required"
  exitCode = 75
} else if (avBlockedUpdate && !selfUpdateRetrySuppressed) {
  admitted = false
  reason = "blocked_self_update_retry_must_be_suppressed"
  exitCode = 75
} else if (avBlockedUpdate && fallbackRoute === "verified_direct_package") {
  if (!officialPackage || !officialManifest) {
    admitted = false
    reason = "official_release_package_and_manifest_required"
    exitCode = 64
  } else if (!packageManifestVerified || !packageDigestVerified || !packageDigestMatches) {
    admitted = false
    reason = "release_package_integrity_not_verified"
    exitCode = 65
  } else if (!stagedVersionDirectory || !atomicCurrentSwitch || !rollbackTargetPreserved || !installedVersionVerified) {
    admitted = false
    reason = "atomic_versioned_install_receipt_incomplete"
    exitCode = 75
  } else {
    reason = "windows_update_rerouted_to_verified_direct_package"
  }
} else if (avBlockedUpdate && fallbackRoute === "continue_pinned_current") {
  if (!currentVersionStillUsable) {
    admitted = false
    reason = "pinned_current_version_not_verified_usable"
    exitCode = 75
  } else {
    reason = "windows_self_update_isolated_current_version_continues"
  }
} else if (avBlockedUpdate) {
  admitted = false
  reason = "safe_update_fallback_required"
  exitCode = 75
}

const report = {
  admitted,
  reason,
  operation_id: operationId,
  platform,
  current_version: currentVersion,
  target_version: targetVersion,
  update_method: updateMethod,
  updater_blocked: updaterBlocked,
  script_contained_malicious_content: scriptContainedMaliciousContent,
  antivirus_detection_recorded: antivirusDetectionRecorded,
  installer_url: installerUrl || null,
  installer_digest_matches: observedInstallerSha256 && expectedInstallerSha256 ? installerDigestMatches : null,
  package_url: packageUrl || null,
  manifest_url: manifestUrl || null,
  package_digest_matches: observedPackageSha256 && expectedPackageSha256 ? packageDigestMatches : null,
  package_manifest_verified: packageManifestVerified,
  staged_version_directory: stagedVersionDirectory,
  atomic_current_switch: atomicCurrentSwitch,
  rollback_target_preserved: rollbackTargetPreserved,
  installed_version_verified: installedVersionVerified,
  fallback_route: fallbackRoute || "none",
  protocol: admitted
    ? "Continue through direct OpenAI control. When the PowerShell updater is blocked by antivirus, suppress updater retry, retain the working pinned version, or install only an official releases.openai.com package whose manifest and SHA-256 are verified before a versioned staged install and atomic current-pointer switch."
    : "Isolate only the blocked updater. Do not disable antivirus, add an unsupported allowlist, use Invoke-Expression alternatives from unofficial sources, or retry the same blocked script. Preserve the current working Codex version, verify official release metadata and package digests, stage the target version separately, keep a rollback target, switch atomically, and verify the installed version before restoring updater authority.",
  resume_condition:
    "Resume normal Windows self-update authority after OpenAI provides a stable updater path that passes active antivirus canaries without ScriptContainedMaliciousContent, or after the verified direct-package path completes with matching official manifest and package SHA-256, atomic version switch, rollback preservation, and post-install version verification.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(exitCode)
