#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PROHIBITED = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const SHA256 = /^[a-f0-9]{64}$/

function emit(payload, code, json) {
  const text = JSON.stringify(payload, null, 2)
  if (json || code === 0) process.stdout.write(`${text}\n`)
  else process.stderr.write(`${payload.message || text}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { input: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--input') {
      options.input = argv[index + 1]
      index += 1
    } else if (value === '--json') {
      options.json = true
    } else if (value === '--help' || value === '-h') {
      process.stdout.write('Usage: codex-mcp-server-config-guard.mjs --input <evidence.json> [--json]\n')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${value}`)
    }
  }
  if (!options.input) throw new Error('--input is required')
  return options
}

function regularFile(file, label, maxBytes = 1024 * 1024) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  return resolved
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function canonicalHome(value, label) {
  const resolved = path.resolve(requireString(value, label))
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be absolute`)
  return resolved
}

function hasProcessConfigOverride(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '-c' || value === '--config' || value.startsWith('--config=') || value.startsWith('-c=')) return true
  }
  return false
}

function comparableFields(expected, observed) {
  const mismatches = []
  for (const [key, value] of Object.entries(expected)) {
    if (value == null) continue
    if (!Object.hasOwn(observed, key)) {
      mismatches.push({ field: key, expected: value, observed: null, reason: 'missing_from_session_configured' })
      continue
    }
    if (JSON.stringify(observed[key]) !== JSON.stringify(value)) {
      mismatches.push({ field: key, expected: value, observed: observed[key], reason: 'effective_value_mismatch' })
    }
  }
  return mismatches
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  emit({ status: 'invalid', message: error.message }, 2, process.argv.includes('--json'))
}

let evidence
try {
  const input = regularFile(options.input, 'input evidence')
  evidence = JSON.parse(fs.readFileSync(input, 'utf8'))
  requireObject(evidence, 'evidence')
  if (evidence.schema_version !== 1) throw new Error('schema_version must equal 1')
} catch (error) {
  emit({ status: 'invalid', message: `could not read evidence: ${error.message}` }, 2, options.json)
}

if (PROHIBITED.test(JSON.stringify(evidence))) {
  emit(
    {
      status: 'rejected',
      reason: 'prohibited_provider_or_route_identifier',
      write_authority_permitted: false,
    },
    64,
    options.json,
  )
}

let launchArgs
let codexHome
let defaultCodexHome
let configPath
let expected
let observed
let perCallConfig
try {
  if (evidence.route !== 'direct_openai') throw new Error('route must equal direct_openai')
  if (typeof evidence.write_authority_requested !== 'boolean') {
    throw new Error('write_authority_requested must be boolean')
  }
  if (!Array.isArray(evidence.launch_args) || evidence.launch_args.some((value) => typeof value !== 'string')) {
    throw new Error('launch_args must be an array of strings')
  }
  launchArgs = evidence.launch_args
  if (launchArgs[0] !== 'mcp-server') throw new Error('launch_args must begin with mcp-server')

  codexHome = canonicalHome(evidence.codex_home, 'codex_home')
  defaultCodexHome = canonicalHome(evidence.default_codex_home || path.join(os.homedir(), '.codex'), 'default_codex_home')
  configPath = regularFile(evidence.config_path, 'config_path')
  const relativeConfig = path.relative(codexHome, configPath)
  if (relativeConfig.startsWith('..') || path.isAbsolute(relativeConfig)) {
    throw new Error('config_path must be contained within codex_home')
  }

  const approvedHash = requireString(evidence.approved_config_sha256, 'approved_config_sha256').toLowerCase()
  if (!SHA256.test(approvedHash)) throw new Error('approved_config_sha256 must be a lowercase SHA-256 digest')
  evidence.approved_config_sha256 = approvedHash

  expected = requireObject(evidence.expected_session, 'expected_session')
  observed = requireObject(evidence.observed_session_configured, 'observed_session_configured')
  perCallConfig = requireObject(evidence.per_call_config, 'per_call_config')
  requireString(expected.model, 'expected_session.model')
  requireString(perCallConfig.model, 'per_call_config.model')
  requireString(observed.model, 'observed_session_configured.model')
} catch (error) {
  emit({ status: 'invalid', message: error.message }, 2, options.json)
}

if (hasProcessConfigOverride(launchArgs)) {
  emit(
    {
      status: 'rejected',
      reason: 'mcp_server_process_config_override_is_not_authoritative',
      write_authority_permitted: false,
      remediation: [
        'Remove -c and --config overrides from the codex mcp-server process launch.',
        'Place the reviewed baseline in an isolated CODEX_HOME/config.toml.',
        'Pass task-specific overrides through the codex tool call config object.',
        'Verify the resulting session_configured event before granting authority.',
      ],
    },
    64,
    options.json,
  )
}

if (codexHome === defaultCodexHome) {
  emit(
    {
      status: 'rejected',
      reason: 'shared_default_codex_home',
      write_authority_permitted: false,
      remediation: ['Use a dedicated absolute CODEX_HOME for this MCP server and authentication boundary.'],
    },
    64,
    options.json,
  )
}

const observedHash = sha256File(configPath)
const hashMatches = observedHash === evidence.approved_config_sha256
const perCallMismatches = comparableFields(expected, perCallConfig)
const sessionMismatches = comparableFields(expected, observed)
const blocked = !hashMatches || perCallMismatches.length > 0 || sessionMismatches.length > 0

const result = {
  status: blocked ? 'effective_mcp_session_config_mismatch' : 'verified',
  codex_home: codexHome,
  config_path: configPath,
  approved_config_sha256: evidence.approved_config_sha256,
  observed_config_sha256: observedHash,
  config_hash_matches: hashMatches,
  process_config_overrides_present: false,
  per_call_config_mismatches: perCallMismatches,
  session_configured_mismatches: sessionMismatches,
  write_authority_requested: evidence.write_authority_requested,
  write_authority_permitted: !blocked,
  task_execution_permitted: !blocked,
  remediation: blocked
    ? [
        'Keep the isolated baseline config file unchanged until its hash is reviewed and approved.',
        'Send the expected model and task policy through the codex tool call config object.',
        'Read session_configured and compare every authority-bearing field before dispatch.',
        'Do not replay an external write until the effective session configuration is verified.',
      ]
    : [],
}

emit(result, blocked ? 75 : 0, options.json)
