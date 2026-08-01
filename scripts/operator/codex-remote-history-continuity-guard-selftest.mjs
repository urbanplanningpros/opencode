import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const script = path.join(path.dirname(new URL(import.meta.url).pathname), "codex-remote-history-continuity-guard.mjs")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-history-guard-"))
const small = path.join(temp, "small.jsonl")
const large = path.join(temp, "large.jsonl")
fs.writeFileSync(small, "x".repeat(128))
fs.writeFileSync(large, "x".repeat(4096))

function run(arguments_, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...arguments_], { encoding: "utf8" })
  if (result.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
  return result
}

function parse(result) {
  return JSON.parse(result.stdout)
}

const base = [
  "--operation-id",
  "op-1",
  "--thread-id",
  "thread-1",
  "--provider",
  "openai",
  "--model",
  "gpt-approved",
  "--max-remote-bytes",
  "1024",
  "--json",
]

const healthy = parse(run([...base, "--rollout", small]))
if (healthy.decision !== "remote_read_allowed" || !healthy.policy.remote_full_read_allowed) {
  throw new Error("small rollout should be allowed")
}

const manifest = path.join(temp, "manifest.json")
const oversized = parse(run([...base, "--rollout", large, "--manifest", manifest]))
if (oversized.decision !== "local_or_successor_required" || oversized.policy.remote_fork_allowed) {
  throw new Error("large rollout should require continuity routing")
}
if (!fs.existsSync(manifest)) throw new Error("manifest was not written")

run([...base, "--rollout", large, "--assert-safe"], 78)
run(
  [
    "--operation-id",
    "op-1",
    "--thread-id",
    "thread-1",
    "--provider",
    "openai",
    "--model",
    "gpt-approved",
    "--rollout-bytes",
    "1",
    "--automatic-model-selection",
    "true",
  ],
  64,
)
run(["--operation-id", "op-1", "--thread-id", "thread-1", "--provider", "other", "--rollout-bytes", "1"], 64)
run(
  [
    "--operation-id",
    "op-1",
    "--thread-id",
    "thread-1",
    "--provider",
    "openai",
    "--model",
    "gpt-approved",
    "--rollout-bytes",
    "1",
    "--gateway",
    "auto",
  ],
  64,
)
run(
  [
    "--operation-id",
    "op-1",
    "--thread-id",
    "thread-1",
    "--provider",
    "openai",
    "--model",
    "gpt-approved",
    "--rollout-bytes",
    "1",
    "--fallbacks",
    "[\"other\"]",
  ],
  64,
)
run(["--thread-id", "thread-1", "--provider", "openai", "--model", "gpt-approved", "--rollout-bytes", "1"], 64)

console.log("codex-remote-history-continuity-guard: 8 fixtures passed")
