import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nowIso, parseArgs } from "./lib.mjs"

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const args = parseArgs(process.argv.slice(2))
const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const sessionsRoot = path.resolve(args["sessions-root"] || path.join(codexHome, "sessions"))
const maxMetaBytes = Number(args["max-meta-bytes"] || process.env.OPERATOR_CODEX_LINEAGE_MAX_META_BYTES || 1 * MiB)
const forkWarnBytes = Number(args["fork-warn-bytes"] || process.env.OPERATOR_CODEX_FORK_WARN_BYTES || 256 * MiB)
const forkCriticalBytes = Number(
  args["fork-critical-bytes"] || process.env.OPERATOR_CODEX_FORK_CRITICAL_BYTES || 2 * GiB,
)

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function walkJsonl(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const stat = fs.statSync(full)
      files.push({ path: full, bytes: stat.size, mtime_ms: stat.mtimeMs })
    }
  }
  return files
}

function readFirstLine(file) {
  const fd = fs.openSync(file, "r")
  try {
    const buffer = Buffer.allocUnsafe(maxMetaBytes)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const chunk = buffer.subarray(0, bytesRead).toString("utf8")
    const newline = chunk.indexOf("\n")
    if (newline === -1 && bytesRead === maxMetaBytes) {
      throw new Error(`session metadata exceeds ${maxMetaBytes} bytes`)
    }
    return newline === -1 ? chunk.trim() : chunk.slice(0, newline).trim()
  } finally {
    fs.closeSync(fd)
  }
}

function normalizeMeta(line) {
  if (!isObject(line)) return null
  let payload = isObject(line.payload) ? line.payload : line
  if (isObject(payload.meta)) payload = payload.meta
  return payload
}

function readLineage(file) {
  let parsed
  try {
    const line = readFirstLine(file.path)
    if (!line) throw new Error("empty rollout")
    parsed = JSON.parse(line)
  } catch (error) {
    return {
      ...file,
      parse_error: error instanceof Error ? error.message : String(error),
      thread_id: null,
      forked_from_id: null,
      history_base_thread_id: null,
      history_mode: null,
    }
  }

  const meta = normalizeMeta(parsed)
  const historyBase = isObject(meta?.history_base)
    ? meta.history_base
    : isObject(meta?.historyBase)
      ? meta.historyBase
      : null

  return {
    ...file,
    parse_error: null,
    thread_id: stringValue(meta?.id, meta?.thread_id, meta?.threadId, meta?.conversation_id, meta?.conversationId),
    forked_from_id: stringValue(meta?.forked_from_id, meta?.forkedFromId),
    history_base_thread_id: stringValue(
      historyBase?.thread_id,
      historyBase?.threadId,
      historyBase?.id,
      historyBase?.conversation_id,
    ),
    history_mode: stringValue(meta?.history_mode, meta?.historyMode),
  }
}

const rollouts = walkJsonl(sessionsRoot).map(readLineage)
const byThread = new Map()
for (const rollout of rollouts) {
  if (!rollout.thread_id) continue
  const group = byThread.get(rollout.thread_id) || []
  group.push(rollout)
  byThread.set(rollout.thread_id, group)
}

const findings = []
for (const [threadId, files] of byThread) {
  if (files.length > 1) {
    findings.push({
      severity: "critical",
      code: "duplicate_thread_rollout",
      thread_id: threadId,
      files: files.map((file) => path.relative(codexHome, file.path)),
    })
  }
}

for (const rollout of rollouts) {
  const relativePath = path.relative(codexHome, rollout.path)
  if (rollout.parse_error) {
    if (rollout.bytes >= forkWarnBytes) {
      findings.push({
        severity: "warning",
        code: "large_rollout_metadata_unreadable",
        path: relativePath,
        bytes: rollout.bytes,
        detail: rollout.parse_error,
      })
    }
    continue
  }

  if (rollout.history_base_thread_id === rollout.thread_id && rollout.thread_id) {
    findings.push({
      severity: "critical",
      code: "history_base_self_reference",
      thread_id: rollout.thread_id,
      path: relativePath,
    })
  }

  if (rollout.history_base_thread_id && !byThread.has(rollout.history_base_thread_id)) {
    findings.push({
      severity: "critical",
      code: "history_base_parent_missing",
      thread_id: rollout.thread_id,
      parent_thread_id: rollout.history_base_thread_id,
      path: relativePath,
    })
  }

  if (rollout.forked_from_id && !rollout.history_base_thread_id && rollout.bytes >= forkWarnBytes) {
    findings.push({
      severity: rollout.bytes >= forkCriticalBytes ? "critical" : "warning",
      code: "fork_materialized_without_history_base",
      thread_id: rollout.thread_id,
      forked_from_id: rollout.forked_from_id,
      path: relativePath,
      bytes: rollout.bytes,
    })
  }
}

const critical = findings.filter((finding) => finding.severity === "critical")
const warnings = findings.filter((finding) => finding.severity === "warning")
const status = critical.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "safe"

const result = {
  checked_at: nowIso(),
  status,
  codex_home: codexHome,
  sessions_root: sessionsRoot,
  rollout_count: rollouts.length,
  parsed_rollout_count: rollouts.filter((rollout) => !rollout.parse_error).length,
  lineage_finding_count: findings.length,
  findings,
  safe_to_fork_or_resume_affected_threads: status === "safe",
  remediation: [
    "Checkpoint the authoritative task manifest outside Codex rollout history.",
    "Do not fork or branch a large thread whose child lacks history_base metadata.",
    "Preserve state-database thread metadata and rollout paths; do not delete rows merely because one rollout file is missing.",
    "Start a fresh approved OpenAI or local task from the manifest and current working tree instead of inheriting full parent history.",
    "Reconcile every uncertain external write before replaying it.",
    "Use a stable upstream release containing lineage fixes only after a disposable fork/resume canary passes.",
  ],
  limits: {
    max_meta_bytes: maxMetaBytes,
    fork_warn_bytes: forkWarnBytes,
    fork_critical_bytes: forkCriticalBytes,
  },
}

console.log(JSON.stringify(result, null, 2))
if (status !== "safe" && !args["no-fail"]) process.exit(2)
