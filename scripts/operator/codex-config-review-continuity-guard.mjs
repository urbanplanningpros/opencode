#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function nowIso() {
  return new Date().toISOString()
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i += 1
    }
  }
  return args
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function normalizeConfigText(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .join('\n')
}

export function classifyPermissionConfig(text) {
  const normalized = normalizeConfigText(text)
  const legacyKeys = []
  const profileKeys = []
  if (/^sandbox_mode\s*=/m.test(normalized)) legacyKeys.push('sandbox_mode')
  if (/^\[sandbox_workspace_write\]/m.test(normalized)) legacyKeys.push('[sandbox_workspace_write]')
  if (/^default_permissions\s*=/m.test(normalized)) profileKeys.push('default_permissions')
  if (/^\[permissions(?:\.|\])/m.test(normalized)) profileKeys.push('[permissions]')
  return {
    legacy_keys: legacyKeys,
    profile_keys: profileKeys,
    mixed_families: legacyKeys.length > 0 && profileKeys.length > 0,
  }
}

export function auditPermissionFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('At least one config file is required')
  const inspected = files.map((file) => {
    const absolute = path.resolve(file)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Config must be a regular file: ${absolute}`)
    const text = fs.readFileSync(absolute, 'utf8')
    return { file: absolute, sha256: sha256(text), ...classifyPermissionConfig(text) }
  })
  const combined = {
    legacy_keys: [...new Set(inspected.flatMap((entry) => entry.legacy_keys))],
    profile_keys: [...new Set(inspected.flatMap((entry) => entry.profile_keys))],
  }
  combined.mixed_families = combined.legacy_keys.length > 0 && combined.profile_keys.length > 0
  return { inspected, combined }
}

function runGit(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

export function buildReviewManifest({ repo, base, head, operationId }) {
  const root = path.resolve(repo)
  const gitRoot = runGit(root, ['rev-parse', '--show-toplevel'])
  if (path.resolve(gitRoot) !== root) throw new Error(`Repository root mismatch: expected ${root}, got ${gitRoot}`)
  const baseSha = runGit(root, ['rev-parse', '--verify', `${base}^{commit}`])
  const headSha = runGit(root, ['rev-parse', '--verify', `${head}^{commit}`])
  const currentBranch = runGit(root, ['branch', '--show-current']) || null
  const currentHead = runGit(root, ['rev-parse', 'HEAD'])
  const worktree = runGit(root, ['rev-parse', '--show-toplevel'])
  const diffNames = runGit(root, ['diff', '--name-status', `${baseSha}...${headSha}`])
  const immutable = {
    operation_id: operationId,
    repository: root,
    worktree,
    current_branch: currentBranch,
    current_head_sha: currentHead,
    requested_base: base,
    requested_base_sha: baseSha,
    requested_head: head,
    requested_head_sha: headSha,
    comparison: `${baseSha}...${headSha}`,
    changed_files_sha256: sha256(diffNames),
    provider: 'openai',
    automatic_model_selection: false,
    gateway: null,
    fallback_chain: [],
  }
  return { schema_version: 1, created_at: nowIso(), ...immutable, manifest_sha256: sha256(JSON.stringify(immutable)) }
}

export function auditRollout(file, imagePayloadThresholdBytes = 32 * 1024 * 1024, rolloutThresholdBytes = 512 * 1024 * 1024) {
  const absolute = path.resolve(file)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Rollout must be a regular file')
  const text = fs.readFileSync(absolute, 'utf8')
  const matches = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || []
  const imageBytes = matches.reduce((total, value) => total + Buffer.byteLength(value), 0)
  const reasons = []
  if (imageBytes >= imagePayloadThresholdBytes) reasons.push('retained_image_payload_threshold')
  if (stat.size >= rolloutThresholdBytes) reasons.push('rollout_size_threshold')
  return {
    schema_version: 1,
    audited_at: nowIso(),
    file: absolute,
    file_sha256: sha256(text),
    rollout_bytes: stat.size,
    retained_image_count: matches.length,
    retained_image_payload_bytes: imageBytes,
    action: reasons.length ? 'rotate_context_with_hash_bound_handoff' : 'continue',
    reasons,
  }
}

async function main(argv) {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  const stateDir = path.resolve(args['state-dir'] || process.env.OPERATOR_STATE_DIR || path.join(os.tmpdir(), 'codex-operator-guard'))

  if (command === 'permissions-audit') {
    const files = args['config-json'] ? JSON.parse(args['config-json']) : []
    const result = auditPermissionFiles(files)
    const receipt = { schema_version: 1, audited_at: nowIso(), ...result }
    const receiptFile = path.join(stateDir, `permissions-${Date.now()}.json`)
    writeJsonAtomic(receiptFile, receipt)
    console.log(JSON.stringify({ ...receipt, receipt_file: receiptFile }))
    if (result.combined.mixed_families) return 78
    return 0
  }

  if (command === 'review-manifest') {
    for (const key of ['repo', 'base', 'head', 'operation-id']) if (!args[key]) throw new Error(`--${key} is required`)
    const manifest = buildReviewManifest({ repo: args.repo, base: args.base, head: args.head, operationId: args['operation-id'] })
    const receiptFile = path.join(stateDir, `review-${manifest.operation_id}-${Date.now()}.json`)
    writeJsonAtomic(receiptFile, manifest)
    console.log(JSON.stringify({ ...manifest, receipt_file: receiptFile }))
    return 0
  }

  if (command === 'rollout-audit') {
    if (!args.file) throw new Error('--file is required')
    const result = auditRollout(
      args.file,
      args['image-threshold-bytes'] ? Number(args['image-threshold-bytes']) : undefined,
      args['rollout-threshold-bytes'] ? Number(args['rollout-threshold-bytes']) : undefined,
    )
    const receiptFile = path.join(stateDir, `rollout-${Date.now()}.json`)
    writeJsonAtomic(receiptFile, result)
    console.log(JSON.stringify({ ...result, receipt_file: receiptFile }))
    return result.action === 'continue' ? 0 : 75
  }

  throw new Error('Usage: codex-config-review-continuity-guard.mjs <permissions-audit|review-manifest|rollout-audit> [options]')
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
