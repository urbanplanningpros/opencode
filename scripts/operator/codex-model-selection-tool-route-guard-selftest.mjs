import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-model-selection-tool-route-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-selection-tool-route-"))

const base = {
  operation_id: "op-model-1",
  selected_model_slug: "gpt-5.6-terra",
  allowed_model_slugs: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  selection: {
    source: "config",
    exact_slug_verified: true,
    display_label_duplicate_count: 1,
  },
  catalog_entry: {
    visibility: "show",
    user_selectable: true,
    tool_mode: "custom",
  },
  tool_probe: {
    execution_requested: true,
    failed_calls: 0,
    observed_error: "",
  },
  state: {
    external_writes_reconciled: true,
    task_state_preserved: true,
    automatic_replay_requested: false,
  },
  continuity_route: {
    type: "direct_openai_cli",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
    pinned_model_slug: "gpt-5.6-sol",
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("healthy-exact-model", structuredClone(base), 0, "model_selection_and_tool_route_verified")

const hidden = structuredClone(base)
hidden.selected_model_slug = "codex-auto-review"
hidden.allowed_model_slugs.push("codex-auto-review")
hidden.selection.source = "picker"
hidden.catalog_entry.visibility = "hide"
hidden.catalog_entry.user_selectable = false
hidden.catalog_entry.tool_mode = ""
run("hidden-picker-entry", hidden, 64, "hidden_model_must_not_be_user_selectable")

const duplicate = structuredClone(base)
duplicate.selection.source = "picker"
duplicate.selection.exact_slug_verified = false
duplicate.selection.display_label_duplicate_count = 2
run("duplicate-label-without-slug", duplicate, 64, "ambiguous_duplicate_model_label")

const autoReview = structuredClone(base)
autoReview.selected_model_slug = "codex-auto-review"
autoReview.allowed_model_slugs.push("codex-auto-review")
autoReview.catalog_entry.visibility = "show"
autoReview.catalog_entry.user_selectable = true
autoReview.catalog_entry.tool_mode = ""
run("auto-review-execution", autoReview, 75, "auto_review_model_not_authorized_for_tool_execution")

const noToolMode = structuredClone(base)
noToolMode.catalog_entry.tool_mode = ""
run("tool-mode-missing", noToolMode, 75, "execution_model_tool_mode_missing")

const failedNoContinuity = structuredClone(base)
failedNoContinuity.tool_probe.observed_error = "unsupported custom tool call: execexec"
failedNoContinuity.tool_probe.failed_calls = 8
failedNoContinuity.continuity_route.canary_passed = false
run("failure-without-canary", failedNoContinuity, 75, "tool_route_failure_requires_reconciled_pinned_continuity")

const failedRecovered = structuredClone(base)
failedRecovered.tool_probe.observed_error = "unsupported custom tool call: execexec"
failedRecovered.tool_probe.failed_calls = 8
run("failure-with-pinned-continuity", failedRecovered, 0, "tool_route_failure_contained_with_verified_pinned_continuity")

const replay = structuredClone(failedRecovered)
replay.state.automatic_replay_requested = true
run("automatic-replay", replay, 64, "automatic_replay_rejected_after_tool_route_failure")

const unapproved = structuredClone(base)
unapproved.selected_model_slug = "codex-auto-review"
run("model-not-allowed", unapproved, 64, "selected_model_not_explicitly_allowed")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
