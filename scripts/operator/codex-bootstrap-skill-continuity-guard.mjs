#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2).replaceAll('-', '_')
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i += 1
    }
  }
  return out
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const sha256Pattern = /^[a-f0-9]{64}$/
const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const args = parseArgs(process.argv.slice(2))

if (!args.input) {
  console.error('Usage: node scripts/operator/codex-bootstrap-skill-continuity-guard.mjs --input <evidence.json> [--json]')
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence must be a regular non-symlink file')
  evidence = JSON.parse(fs.readFileSync(input, 'utf8'))
} catch (error) {
  console.error(`Unable to read bootstrap/skill evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []
const operation = text(evidence.operation).toLowerCase()
const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const fallback = text(evidence.fallback).toLowerCase() || 'none'

if (!['skill_validation', 'windows_install'].includes(operation)) blocked.push('unsupported_operation')
if (!provider) blocked.push('routing_provider_missing')
if (provider && !['openai', 'approved-local'].includes(provider)) blocked.push('unapproved_provider')
if (routing.automatic_selector === true) blocked.push('automatic_selector_enabled')
if (routing.model_gateway === true) blocked.push('model_gateway_enabled')
if (prohibited.test(`${provider} ${route} ${fallback}`)) blocked.push('prohibited_route_metadata')

const taskId = text(evidence.task_id)
const operationId = text(evidence.operation_id)
const idempotencyKey = text(evidence.idempotency_key)
if (!taskId) blocked.push('task_id_missing')
if (!operationId) blocked.push('operation_id_missing')
if (!idempotencyKey) blocked.push('idempotency_key_missing')

if (operation === 'skill_validation') {
  const allowedFallbacks = new Set(['isolated_uv_pyyaml', 'dependency_free_local_validator'])
  const bundled = evidence.bundled_quick_validate === true
  const pyyamlDeclared = evidence.pyyaml_declared === true
  const pyyamlAvailable = evidence.pyyaml_available === true
  const failure = /no module named ['"]?yaml|modulenotfounderror.*yaml/i.test(text(evidence.error))
  const affected = bundled && !pyyamlDeclared && !pyyamlAvailable && failure

  if (evidence.modify_system_managed_skill === true) blocked.push('system_managed_skill_modification_forbidden')
  if (evidence.global_python_package_install === true) blocked.push('global_python_package_install_forbidden')
  if (!allowedFallbacks.has(fallback)) blocked.push('approved_skill_validation_fallback_required')

  if (affected) {
    if (evidence.skill_tree_preserved !== true) blocked.push('skill_tree_preservation_required')
    if (fallback === 'isolated_uv_pyyaml') {
      if (!/^pyyaml==[0-9]+\.[0-9]+\.[0-9]+$/i.test(text(evidence.pinned_dependency))) {
        blocked.push('exact_pyyaml_pin_required')
      }
      if (evidence.isolated_environment !== true) blocked.push('isolated_environment_required')
      if (evidence.validation_canary_passed !== true) remediation.push('run_skill_validation_canary')
    }
    if (fallback === 'dependency_free_local_validator') {
      if (!sha256Pattern.test(text(evidence.validator_sha256).toLowerCase())) blocked.push('validator_sha256_required')
      if (evidence.validation_canary_passed !== true) remediation.push('run_dependency_free_validator_canary')
    }
  } else if (bundled && !pyyamlDeclared && !pyyamlAvailable) {
    warnings.push('preflight_detected_undeclared_pyyaml_dependency')
  }
}

if (operation === 'windows_install') {
  const allowedFallbacks = new Set(['official_installer_no_profile', 'official_release_binary'])
  if (!allowedFallbacks.has(fallback)) blocked.push('approved_windows_install_route_required')
  if (evidence.shell_profile_loaded === true) blocked.push('powershell_profile_loading_forbidden')
  if (evidence.no_profile_flag !== true) blocked.push('powershell_no_profile_required')
  if (evidence.non_interactive_flag !== true) warnings.push('powershell_noninteractive_recommended')
  if (evidence.execution_policy_scope !== 'process') blocked.push('process_scoped_execution_policy_required')
  if (evidence.install_source_official_openai !== true) blocked.push('official_openai_install_source_required')
  if (evidence.repeated_blind_retry === true) blocked.push('blind_install_retry_forbidden')
  if (evidence.postinstall_version_canary_passed !== true) remediation.push('run_codex_version_and_path_canary')
  if (fallback === 'official_release_binary' && !sha256Pattern.test(text(evidence.release_asset_sha256).toLowerCase())) {
    blocked.push('release_asset_sha256_required')
  }
}

const status = blocked.length > 0 ? 'blocked' : remediation.length > 0 ? 'remediation_required' : 'compatible'
const result = {
  checked_at: new Date().toISOString(),
  status,
  operation,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  task_id: taskId || null,
  operation_id: operationId || null,
  fallback,
  evidence_sha256: sha256(JSON.stringify(evidence)),
  continuity_route:
    operation === 'skill_validation'
      ? 'Preserve the user-owned skill tree and validate through an isolated, exact-pinned PyYAML environment or a checksum-bound dependency-free local validator; do not modify the bundled system skill or global Python.'
      : 'Run the official OpenAI installer in a clean PowerShell process with -NoProfile and process-scoped policy, or use a checksum-verified official release binary; then verify the resolved codex path and version.',
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex bootstrap/skill boundary: ${status}`)
  if (result.blocked.length) console.error(`Blocked: ${result.blocked.join(', ')}`)
  if (result.remediation.length) console.error(`Remediation: ${result.remediation.join(', ')}`)
  if (result.warnings.length) console.error(`Warnings: ${result.warnings.join(', ')}`)
}

if (blocked.length) process.exit(64)
if (remediation.length) process.exit(75)
process.exit(0)
