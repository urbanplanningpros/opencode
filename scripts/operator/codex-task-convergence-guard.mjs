#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"

const SHA256 = /^[a-f0-9]{64}$/i
const PROHIBITED = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i

function emit(code, admitted, message, extra = {}) {
  process.stdout.write(`${JSON.stringify({ admitted, code, message, ...extra }, null, 2)}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--input") args.input = argv[++index]
    else if (token === "--json") args.json = true
    else emit(2, false, `Unknown argument: ${token}`)
  }
  if (!args.input) emit(2, false, "Usage: codex-task-convergence-guard.mjs --input <evidence.json> [--json]")
  return args
}

function readJson(file) {
  const resolved = path.resolve(file)
  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch (error) {
    emit(2, false, `Unable to read evidence: ${error.message}`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) emit(64, false, "Evidence must be a regular non-symlink file")
  if (stat.size > 1024 * 1024) emit(64, false, "Evidence exceeds the 1 MiB limit")
  try {
    return { resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")) }
  } catch (error) {
    emit(2, false, `Malformed JSON evidence: ${error.message}`)
  }
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) emit(2, false, `${name} must be a non-negative integer`)
}

const args = parseArgs(process.argv.slice(2))
const { resolved, value: evidence } = readJson(args.input)
if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) emit(2, false, "Evidence must be a JSON object")
if (PROHIBITED.test(JSON.stringify(evidence))) emit(64, false, "Evidence contains a prohibited provider, gateway, or automatic-selection identifier")

for (const field of ["task_id", "operation_id"]) {
  if (typeof evidence[field] !== "string" || evidence[field].trim().length === 0) emit(2, false, `${field} is required`)
}
if (!new Set(["openai", "local"]).has(evidence.route)) emit(64, false, "route must be direct OpenAI or the explicitly authorized local route")
if (!SHA256.test(evidence.completion_criteria_sha256 || "")) emit(2, false, "completion_criteria_sha256 must be a SHA-256 digest")
if (evidence.current_completion_criteria_sha256 !== evidence.completion_criteria_sha256) {
  emit(64, false, "Completion criteria changed without a new authorized task manifest")
}

const limits = evidence.limits || {}
for (const field of ["max_elapsed_seconds", "max_correction_cycles", "max_consecutive_nonreducing_cycles"]) {
  nonNegativeInteger(limits[field], `limits.${field}`)
}
const progress = evidence.progress || {}
for (const field of ["elapsed_seconds", "correction_cycles", "consecutive_nonreducing_cycles", "new_work_items_this_cycle"]) {
  nonNegativeInteger(progress[field], `progress.${field}`)
}
if (!Array.isArray(progress.remaining_item_ids) || progress.remaining_item_ids.some((item) => typeof item !== "string" || !item)) {
  emit(2, false, "progress.remaining_item_ids must be an array of non-empty strings")
}
if (!Array.isArray(progress.completed_item_ids) || progress.completed_item_ids.some((item) => typeof item !== "string" || !item)) {
  emit(2, false, "progress.completed_item_ids must be an array of non-empty strings")
}
if (typeof evidence.subagents_enabled !== "boolean") emit(2, false, "subagents_enabled must be boolean")
if (evidence.subagents_enabled) emit(64, false, "Subagents must remain disabled on the authoritative guarded route")
if (progress.new_subagents_started && progress.new_subagents_started !== 0) emit(64, false, "No new subagents may be started")

const limitReasons = []
if (progress.elapsed_seconds >= limits.max_elapsed_seconds) limitReasons.push("elapsed_time_limit")
if (progress.correction_cycles >= limits.max_correction_cycles) limitReasons.push("correction_cycle_limit")
if (progress.consecutive_nonreducing_cycles >= limits.max_consecutive_nonreducing_cycles) {
  limitReasons.push("nonreducing_cycle_limit")
}
if (evidence.stop_requested === true) limitReasons.push("operator_stop_requested")

const workExpanded = progress.new_work_items_this_cycle > 0 && progress.completed_item_ids.length === 0
if (workExpanded) limitReasons.push("unjustified_work_expansion")

const terminalRequired = limitReasons.length > 0
if (!terminalRequired) {
  emit(0, true, "Task remains inside the bounded convergence envelope", {
    evidence: resolved,
    task_id: evidence.task_id,
    operation_id: evidence.operation_id,
    remaining_items: progress.remaining_item_ids.length,
    correction_cycles: progress.correction_cycles,
  })
}

if (evidence.external_write_outcome === "uncertain" && evidence.external_write_reconciled !== true) {
  emit(64, false, "Uncertain external writes must be reconciled before terminal snapshot or replay", {
    reasons: limitReasons,
  })
}

const snapshot = evidence.terminal_snapshot || {}
if (snapshot.created !== true) {
  emit(75, false, "Convergence limit reached; create and verify a terminal task snapshot", {
    reasons: limitReasons,
    required_actions: [
      "Stop creating tasks, agents, reviews, or verification gates.",
      "Preserve the current diff and dirty-path manifest.",
      "Commit and push to the existing task branch or a safe snapshot branch when repository writes are authorized.",
      "Open or update a draft pull request and record the immutable commit SHA.",
      "Persist the continuation state outside model memory, then end the current task.",
    ],
  })
}

if (!SHA256.test(snapshot.diff_manifest_sha256 || "")) emit(64, false, "terminal_snapshot.diff_manifest_sha256 is required")
if (snapshot.repository_dirty === true) emit(64, false, "Terminal snapshot cannot claim completion while the task-owned worktree remains dirty")
if (snapshot.repository_write_authorized === true) {
  if (!/^[a-f0-9]{40}$/i.test(snapshot.commit_sha || "")) emit(64, false, "A verified 40-character commit SHA is required")
  if (typeof snapshot.branch !== "string" || snapshot.branch.length === 0) emit(64, false, "terminal_snapshot.branch is required")
  if (typeof snapshot.draft_pr_url !== "string" || !/^https:\/\/github\.com\//i.test(snapshot.draft_pr_url)) {
    emit(64, false, "terminal_snapshot.draft_pr_url must be a GitHub draft pull request URL")
  }
}
if (snapshot.state_persisted_outside_model_memory !== true) emit(64, false, "Provider-neutral continuation state must be persisted")
if (snapshot.no_new_work_after_snapshot !== true) emit(64, false, "No new work may be admitted after the terminal snapshot")

emit(0, true, "Terminal snapshot verified; end the current task without another correction cycle", {
  terminal: true,
  reasons: limitReasons,
  task_id: evidence.task_id,
  operation_id: evidence.operation_id,
  commit_sha: snapshot.commit_sha || null,
  draft_pr_url: snapshot.draft_pr_url || null,
})
