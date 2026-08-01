#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { auditPermissionFiles, auditRollout, buildReviewManifest, classifyPermissionConfig } from './codex-config-review-continuity-guard.mjs'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-guard-selftest-'))
try {
  assert.deepEqual(classifyPermissionConfig('sandbox_mode = "read-only"'), {
    legacy_keys: ['sandbox_mode'], profile_keys: [], mixed_families: false,
  })
  assert.equal(classifyPermissionConfig('sandbox_mode = "read-only"\ndefault_permissions = ":workspace"').mixed_families, true)

  const a = path.join(temp, 'a.toml')
  const b = path.join(temp, 'b.toml')
  fs.writeFileSync(a, 'sandbox_mode = "read-only"\n')
  fs.writeFileSync(b, 'default_permissions = ":workspace"\n')
  assert.equal(auditPermissionFiles([a, b]).combined.mixed_families, true)

  const rollout = path.join(temp, 'rollout.jsonl')
  fs.writeFileSync(rollout, JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(1024) }) + '\n')
  const rolloutResult = await auditRollout(rollout, 512, 999999)
  assert.equal(rolloutResult.action, 'rotate_context_with_hash_bound_handoff')
  assert.equal(rolloutResult.retained_image_count, 1)
  assert.ok(rolloutResult.retained_image_payload_bytes >= 1024)

  const repo = path.join(temp, 'repo')
  fs.mkdirSync(repo)
  spawnSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.email', 'selftest@example.com'], { cwd: repo })
  spawnSync('git', ['config', 'user.name', 'Self Test'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  spawnSync('git', ['add', '.'], { cwd: repo })
  spawnSync('git', ['commit', '-m', 'base'], { cwd: repo })
  spawnSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
  spawnSync('git', ['commit', '-am', 'feature'], { cwd: repo })
  const manifest = buildReviewManifest({ repo, base: 'main', head: 'feature', operationId: 'review-1' })
  assert.equal(manifest.requested_head, 'feature')
  assert.equal(manifest.requested_base, 'main')
  assert.equal(manifest.provider, 'openai')
  assert.equal(manifest.automatic_model_selection, false)

  console.log(JSON.stringify({ status: 'passed', checks: 12 }))
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
