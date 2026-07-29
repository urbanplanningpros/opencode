#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"

const PROHIBITED = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const SHA256 = /^[a-f0-9]{64}$/i

function fail(code, message, details = {}) {
  const output = { admitted: false, code, message, ...details }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--input") result.input = argv[++index]
    else if (value === "--json") result.json = true
    else fail(2, `Unknown argument: ${value}`)
  }
  if (!result.input) fail(2, "Usage: codex-exec-server-environment-contract-guard.mjs --input <evidence.json> [--json]")
  return result
}

function isAbsoluteShellPath(value) {
  if (typeof value !== "string" || value.length === 0) return false
  return path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
}

function readEvidence(file) {
  const resolved = path.resolve(file)
  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch (error) {
    fail(2, `Unable to read evidence: ${error.message}`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(64, "Evidence must be a regular non-symlink file")
  if (stat.size > 1024 * 1024) fail(64, "Evidence exceeds the 1 MiB limit")
  try {
    return { resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")) }
  } catch (error) {
    fail(2, `Malformed JSON evidence: ${error.message}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const { resolved, value: evidence } = readEvidence(args.input)

if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail(2, "Evidence must be a JSON object")
if (PROHIBITED.test(JSON.stringify(evidence))) fail(64, "Evidence contains a prohibited provider, gateway, or automatic-selection identifier")

for (const field of ["task_id", "operation_id", "environment_id"]) {
  if (typeof evidence[field] !== "string" || evidence[field].trim().length === 0) fail(2, `${field} is required`)
}
if (!SHA256.test(evidence.bridge_identity_sha256 || "")) fail(2, "bridge_identity_sha256 must be a SHA-256 hex digest")
if (!new Set(["openai", "local"]).has(evidence.route)) fail(64, "route must be direct OpenAI or the explicitly authorized local route")
if (typeof evidence.requires_explicit_shell !== "boolean") fail(2, "requires_explicit_shell must be boolean")
if (typeof evidence.process_start_dispatched !== "boolean") fail(2, "process_start_dispatched must be boolean")

const info = evidence.environment_info
if (!info || typeof info !== "object" || Array.isArray(info)) fail(2, "environment_info is required")
if (info.method !== "environment/info") fail(64, "The environment capability probe must use environment/info")
if (info.requested !== true) fail(64, "environment/info must be requested before granting shell authority")
if (info.observed_before_process_start !== true) fail(64, "environment/info must be observed before process/start")

if (info.status !== "success") {
  if (evidence.process_start_dispatched === true) {
    fail(64, "process/start was dispatched even though environment/info did not establish shell capability")
  }
  if (evidence.host_retained_predispatch_failure !== true || evidence.codex_rollout_retained_predispatch_failure !== true) {
    fail(64, "A failed environment/info probe must be retained by both the host trajectory and Codex rollout")
  }
  fail(75, "Exec-server environment is incompatible with explicit-shell dispatch", {
    compatibility_status: info.status,
    remediation: [
      "Implement environment/info on the same reviewed bridge identity.",
      "Return shell.name, an absolute shell.path, and cwd as a PathUri.",
      "Start a fresh bounded task after the bridge contract passes.",
      "Continue unrelated work through direct OpenAI or the explicitly authorized local route.",
    ],
  })
}

if (evidence.requires_explicit_shell) {
  if (!info.shell || typeof info.shell !== "object") fail(64, "Explicit-shell execution requires environment_info.shell")
  if (typeof info.shell.name !== "string" || info.shell.name.trim().length === 0) fail(64, "environment_info.shell.name is required")
  if (!isAbsoluteShellPath(info.shell.path)) fail(64, "environment_info.shell.path must be an absolute reviewed executable path")
  if (typeof info.cwd_uri !== "string" || !/^file:\/\//i.test(info.cwd_uri)) fail(64, "environment_info.cwd_uri must be a file: PathUri")
  if (evidence.path_uri_treated_as_uri !== true) fail(64, "PathUri must be decoded as a URI before native-path use")
}

if (evidence.process_start_dispatched !== true) fail(75, "Environment contract is valid, but process/start was not observed")
if (evidence.host_retained_process_start !== true || evidence.codex_rollout_retained_process_start !== true) {
  fail(64, "process/start must be retained in both the host trajectory and Codex rollout")
}

const output = {
  admitted: true,
  code: 0,
  evidence: resolved,
  task_id: evidence.task_id,
  operation_id: evidence.operation_id,
  environment_id: evidence.environment_id,
  bridge_identity_sha256: evidence.bridge_identity_sha256,
  route: evidence.route,
  shell: info.shell || null,
  cwd_uri: info.cwd_uri || null,
  process_start_observed: true,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
