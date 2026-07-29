#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const guard = path.join(path.dirname(new URL(import.meta.url).pathname), 'codex-mcp-server-config-guard.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-config-'))
const codexHome = path.join(root, 'isolated-codex-home')
const defaultCodexHome = path.join(root, 'default-codex-home')
fs.mkdirSync(codexHome, { recursive: true })
fs.mkdirSync(defaultCodexHome, { recursive: true })
const configPath = path.join(codexHome, 'config.toml')
fs.writeFileSync(configPath, 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\n', { mode: 0o600 })
const configHash = crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex')

function run(name, evidence) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 })
  const result = spawnSync(process.execPath, [guard, '--input', file, '--json'], { encoding: 'utf8' })
  return { ...result, json: JSON.parse(result.stdout) }
}

const base = {
  schema_version: 1,
  route: 'direct_openai',
  codex_cli_version: '0.145.0',
  codex_home: codexHome,
  default_codex_home: defaultCodexHome,
  config_path: configPath,
  approved_config_sha256: configHash,
  launch_args: ['mcp-server'],
  per_call_config: {
    model: 'gpt-5.6-luna',
    approvals_reviewer: 'user',
  },
  expected_session: {
    model: 'gpt-5.6-luna',
    approvals_reviewer: 'user',
  },
  observed_session_configured: {
    model: 'gpt-5.6-luna',
    approvals_reviewer: 'user',
  },
  write_authority_requested: true,
}

const healthy = run('healthy', base)
assert.equal(healthy.status, 0)
assert.equal(healthy.json.status, 'verified')
assert.equal(healthy.json.write_authority_permitted, true)

const ignoredProcessOverride = structuredClone(base)
ignoredProcessOverride.launch_args = ['mcp-server', '-c', 'model="gpt-5.6-luna"']
const ignoredProcessOverrideResult = run('process-override', ignoredProcessOverride)
assert.equal(ignoredProcessOverrideResult.status, 64)
assert.equal(ignoredProcessOverrideResult.json.reason, 'mcp_server_process_config_override_is_not_authoritative')

const mismatchedSession = structuredClone(base)
mismatchedSession.observed_session_configured.model = 'unexpected-model'
const mismatchedSessionResult = run('mismatched-session', mismatchedSession)
assert.equal(mismatchedSessionResult.status, 75)
assert.equal(mismatchedSessionResult.json.session_configured_mismatches[0].field, 'model')
assert.equal(mismatchedSessionResult.json.write_authority_permitted, false)

const missingPerCallPolicy = structuredClone(base)
delete missingPerCallPolicy.per_call_config.approvals_reviewer
const missingPerCallPolicyResult = run('missing-per-call-policy', missingPerCallPolicy)
assert.equal(missingPerCallPolicyResult.status, 75)
assert.equal(missingPerCallPolicyResult.json.per_call_config_mismatches[0].field, 'approvals_reviewer')

const sharedHome = structuredClone(base)
sharedHome.codex_home = defaultCodexHome
sharedHome.config_path = path.join(defaultCodexHome, 'config.toml')
fs.copyFileSync(configPath, sharedHome.config_path)
sharedHome.approved_config_sha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(sharedHome.config_path))
  .digest('hex')
const sharedHomeResult = run('shared-home', sharedHome)
assert.equal(sharedHomeResult.status, 64)
assert.equal(sharedHomeResult.json.reason, 'shared_default_codex_home')

const changedConfig = structuredClone(base)
fs.appendFileSync(configPath, 'approval_policy = "on-request"\n')
const changedConfigResult = run('changed-config', changedConfig)
assert.equal(changedConfigResult.status, 75)
assert.equal(changedConfigResult.json.config_hash_matches, false)

fs.writeFileSync(configPath, 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\n', { mode: 0o600 })
const prohibited = structuredClone(base)
prohibited.route_note = 'gateway-auto-select'
const prohibitedResult = run('prohibited', prohibited)
assert.equal(prohibitedResult.status, 64)
assert.equal(prohibitedResult.json.reason, 'prohibited_provider_or_route_identifier')

fs.rmSync(root, { recursive: true, force: true })
process.stdout.write('Codex MCP server config guard self-test passed\n')
