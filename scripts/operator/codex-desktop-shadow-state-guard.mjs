import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nowIso, parseArgs, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))

function absolute(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty absolute path`)
  }
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return path.resolve(value)
}

function canonical(value) {
  return fs.existsSync(value) ? fs.realpathSync.native(value) : path.resolve(value)
}

function inspect(value) {
  if (!fs.existsSync(value)) return { exists: false }
  const stat = fs.lstatSync(value)
  return {
    exists: true,
    type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    mode: `0${(stat.mode & 0o777).toString(8)}`,
  }
}

let configuredHome
let defaultHome
let shadowDatabase

try {
  defaultHome = absolute(args["default-codex-home"] || path.join(os.homedir(), ".codex"), "default Codex home")
  configuredHome = absolute(args["codex-home"] || process.env.CODEX_HOME || defaultHome, "configured Codex home")
  shadowDatabase = absolute(args["shadow-db"] || path.join(defaultHome, "sqlite", "codex-dev.db"), "shadow database")
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const configuredState = inspect(configuredHome)
if (!configuredState.exists || configuredState.type !== "directory") {
  console.error(`Configured Codex home must be an existing directory: ${configuredHome}`)
  process.exit(64)
}

const configuredCanonical = canonical(configuredHome)
const defaultCanonical = canonical(defaultHome)
const shadowState = inspect(shadowDatabase)
const sameProfile = configuredCanonical === defaultCanonical

const reasons = []
if (!sameProfile && shadowState.exists) {
  reasons.push("desktop_shadow_database_outside_configured_codex_home")
  if (shadowState.type !== "file") reasons.push(`shadow_database_type=${shadowState.type}`)
}

const status = sameProfile
  ? "default_profile"
  : shadowState.exists
    ? "desktop_admission_blocked"
    : "isolated_profile_clean"

const report = {
  schema_version: 1,
  observed_at: nowIso(),
  status,
  configured_codex_home: configuredCanonical,
  default_codex_home: defaultCanonical,
  shadow_database: {
    path: shadowDatabase,
    ...shadowState,
  },
  isolation: {
    configured_home_is_default: sameProfile,
    desktop_state_isolation_verified: sameProfile || !shadowState.exists,
    safe_to_launch_desktop: sameProfile || !shadowState.exists,
    safe_to_use_guarded_cli: true,
  },
  reasons,
  remediation:
    reasons.length === 0
      ? null
      : "Do not launch Codex Desktop against this OS profile. Preserve the shadow database, use a dedicated OS account for Desktop isolation, and continue through the guarded direct-OpenAI CLI or explicitly authorized local route.",
}

let evidenceFile = null
if (!args["no-evidence"]) {
  const directory = path.resolve(args["evidence-dir"] || path.join(stateRoot(args), "desktop-shadow-state"))
  evidenceFile = path.join(directory, `${report.observed_at.replace(/[:.]/g, "-")}.json`)
  writeJsonAtomic(evidenceFile, report)
}

const result = { ...report, evidence_file: evidenceFile }
if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex Desktop state isolation: ${status}`)
  console.log(`Configured home: ${configuredCanonical}`)
  console.log(`Default home: ${defaultCanonical}`)
  console.log(`Shadow database: ${shadowState.exists ? shadowDatabase : "not present"}`)
  if (evidenceFile) console.log(`Evidence: ${evidenceFile}`)
  if (reasons.length > 0) console.error(`Blocked: ${reasons.join(", ")}`)
}

process.exit(reasons.length === 0 ? 0 : 75)
