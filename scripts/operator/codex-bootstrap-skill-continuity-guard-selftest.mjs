#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const guard = path.resolve('scripts/operator/codex-bootstrap-skill-continuity-guard.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bootstrap-skill-guard-'))
const sha = 'a'.repeat(64)
const base = {
  task_id: 'task-1',
  operation_id: 'op-1',
  idempotency_key: 'idem-1',
  routing: { provider: 'openai', route: 'direct_openai', automatic_selector: false, model_gateway: false },
}

const fixtures = [
  {
    name: 'isolated skill validator passes',
    expected: 0,
    input: { ...base, operation: 'skill_validation', bundled_quick_validate: true, pyyaml_declared: false, pyyaml_available: false, error: "ModuleNotFoundError: No module named 'yaml'", fallback: 'isolated_uv_pyyaml', pinned_dependency: 'PyYAML==6.0.2', isolated_environment: true, validation_canary_passed: true, skill_tree_preserved: true },
  },
  {
    name: 'global PyYAML install blocked',
    expected: 64,
    input: { ...base, operation: 'skill_validation', bundled_quick_validate: true, pyyaml_declared: false, pyyaml_available: false, error: "No module named 'yaml'", fallback: 'isolated_uv_pyyaml', pinned_dependency: 'PyYAML==6.0.2', isolated_environment: true, validation_canary_passed: true, skill_tree_preserved: true, global_python_package_install: true },
  },
  {
    name: 'system skill modification blocked',
    expected: 64,
    input: { ...base, operation: 'skill_validation', bundled_quick_validate: true, pyyaml_declared: false, pyyaml_available: false, error: "No module named 'yaml'", fallback: 'dependency_free_local_validator', validator_sha256: sha, validation_canary_passed: true, skill_tree_preserved: true, modify_system_managed_skill: true },
  },
  {
    name: 'missing validation canary requires remediation',
    expected: 75,
    input: { ...base, operation: 'skill_validation', bundled_quick_validate: true, pyyaml_declared: false, pyyaml_available: false, error: "No module named 'yaml'", fallback: 'dependency_free_local_validator', validator_sha256: sha, validation_canary_passed: false, skill_tree_preserved: true },
  },
  {
    name: 'unpinned dependency blocked',
    expected: 64,
    input: { ...base, operation: 'skill_validation', bundled_quick_validate: true, pyyaml_declared: false, pyyaml_available: false, error: "No module named 'yaml'", fallback: 'isolated_uv_pyyaml', pinned_dependency: 'PyYAML', isolated_environment: true, validation_canary_passed: true, skill_tree_preserved: true },
  },
  {
    name: 'clean PowerShell installer passes',
    expected: 0,
    input: { ...base, operation: 'windows_install', fallback: 'official_installer_no_profile', shell_profile_loaded: false, no_profile_flag: true, non_interactive_flag: true, execution_policy_scope: 'process', install_source_official_openai: true, repeated_blind_retry: false, postinstall_version_canary_passed: true },
  },
  {
    name: 'profile-loaded install blocked',
    expected: 64,
    input: { ...base, operation: 'windows_install', fallback: 'official_installer_no_profile', shell_profile_loaded: true, no_profile_flag: false, non_interactive_flag: true, execution_policy_scope: 'process', install_source_official_openai: true, repeated_blind_retry: false, postinstall_version_canary_passed: true },
  },
  {
    name: 'nonofficial source blocked',
    expected: 64,
    input: { ...base, operation: 'windows_install', fallback: 'official_installer_no_profile', shell_profile_loaded: false, no_profile_flag: true, non_interactive_flag: true, execution_policy_scope: 'process', install_source_official_openai: false, repeated_blind_retry: false, postinstall_version_canary_passed: true },
  },
  {
    name: 'release binary requires hash',
    expected: 64,
    input: { ...base, operation: 'windows_install', fallback: 'official_release_binary', shell_profile_loaded: false, no_profile_flag: true, non_interactive_flag: true, execution_policy_scope: 'process', install_source_official_openai: true, repeated_blind_retry: false, postinstall_version_canary_passed: true },
  },
  {
    name: 'prohibited route blocked',
    expected: 64,
    input: { ...base, operation: 'windows_install', fallback: 'official_installer_no_profile', shell_profile_loaded: false, no_profile_flag: true, non_interactive_flag: true, execution_policy_scope: 'process', install_source_official_openai: true, repeated_blind_retry: false, postinstall_version_canary_passed: true, routing: { provider: 'openai', route: 'model-gateway-auto-select' } },
  },
]

let failures = 0
for (const fixture of fixtures) {
  const file = path.join(tmp, `${fixture.name.replaceAll(/[^a-z0-9]+/gi, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(fixture.input))
  const result = spawnSync(process.execPath, [guard, '--input', file, '--json'], { encoding: 'utf8' })
  if (result.status !== fixture.expected) {
    failures += 1
    console.error(`FAIL ${fixture.name}: expected ${fixture.expected}, got ${result.status}\n${result.stdout}\n${result.stderr}`)
  } else {
    console.log(`PASS ${fixture.name}`)
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
if (failures) process.exit(1)
console.log(`Passed ${fixtures.length} deterministic fixtures.`)
