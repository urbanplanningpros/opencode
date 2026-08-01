import assert from "node:assert/strict"
import {
  buildPinnedLaunchPlan,
  descendantsOf,
  evaluateMemorySamples,
  parsePsOutput,
  summarizeProcessSample,
} from "./codex-runtime-continuity-guard.mjs"

const processes = parsePsOutput(`
 100 1 1048576 codex app-server
 101 100 524288 node tool-a
 102 100 262144 python tool-b
 103 101 131072 child
 999 1 65536 unrelated
`)
assert.equal(processes.length, 5)
assert.deepEqual(
  descendantsOf(100, processes).map((process) => process.pid).sort((a, b) => a - b),
  [101, 102, 103],
)
const summary = summarizeProcessSample(processes, 100, "2026-08-01T00:00:00.000Z")
assert.equal(summary.target.rss_mib, 1024)
assert.equal(summary.descendants.rss_mib, 896)
assert.equal(summary.tree_rss_mib, 1920)

const healthy = evaluateMemorySamples(
  [summary, { ...summary, tree_rss_mib: 2000, target: { ...summary.target, rss_mib: 1100 } }],
  { targetRssMiB: 6144, treeRssMiB: 8192, growthMiB: 1024, growthRatio: 0.25 },
)
assert.equal(healthy.status, "healthy")

const leaking = evaluateMemorySamples(
  [summary, { ...summary, tree_rss_mib: 4000, target: { ...summary.target, rss_mib: 2500 } }],
  { targetRssMiB: 6144, treeRssMiB: 8192, growthMiB: 1024, growthRatio: 0.25 },
)
assert.equal(leaking.status, "drain_required")
assert.ok(leaking.reasons.some((reason) => reason.startsWith("tree_growth_mib=")))

const oversized = evaluateMemorySamples(
  [{ ...summary, tree_rss_mib: 9000, target: { ...summary.target, rss_mib: 7000 } }],
  { targetRssMiB: 6144, treeRssMiB: 8192, growthMiB: 1024, growthRatio: 0.25 },
)
assert.equal(oversized.status, "drain_required")
assert.equal(oversized.reasons.length, 2)

const plan = buildPinnedLaunchPlan({
  approvedModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  operationId: "op-123",
  binary: "codex",
  cwd: "/tmp/work",
  passthrough: ["--sandbox", "workspace-write"],
})
assert.equal(plan.provider, "openai")
assert.equal(plan.automatic_model_selection, false)
assert.deepEqual(plan.fallback_chain, [])
assert.deepEqual(plan.args.slice(0, 6), [
  "--model",
  "gpt-5.6-terra",
  "-c",
  "model_provider=openai",
  "-c",
  "model_reasoning_effort=high",
])

assert.throws(
  () =>
    buildPinnedLaunchPlan({
      approvedModels: ["gpt-5.6-sol"],
      model: "auto",
      passthrough: [],
    }),
  /not in the approved OpenAI allowlist/,
)
assert.throws(
  () =>
    buildPinnedLaunchPlan({
      approvedModels: ["gpt-5.6-sol"],
      model: "gpt-5.6-sol",
      passthrough: ["--model", "gpt-5.6-luna"],
    }),
  /Conflicting route selector/,
)
assert.throws(
  () =>
    buildPinnedLaunchPlan({
      approvedModels: ["gpt-5.6-sol"],
      model: "gpt-5.6-sol",
      passthrough: ["-c", "model_provider=other"],
    }),
  /Conflicting route selector/,
)

console.log("codex-runtime-continuity-guard self-test passed")
