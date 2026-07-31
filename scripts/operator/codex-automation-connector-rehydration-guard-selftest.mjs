import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-automation-connector-rehydration-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-connectors-"))

const base = {
  operation_id: "op-auto-connectors-1",
  turn: {
    thread_source: "automation",
    is_followup: true,
    apps_instructions_before: true,
    apps_instructions_after: true,
    explicit_apps_disable: false,
    canonical_thread_preserved: true,
  },
  connectors: {
    auth_still_valid: true,
    required_families: ["gmail", "calendar"],
    registered_families: ["gmail", "calendar", "drive"],
    read_only_canary_passed: true,
    catalog_revision_readback: true,
    oauth_reconnect_requested: false,
    permission_broadening_requested: false,
  },
  state: {
    task_state_preserved: true,
    prior_turn_preserved: true,
    external_writes_reconciled: true,
    stale_answer_accepted: false,
    automatic_replay_requested: false,
    unrelated_work_continues: true,
  },
  continuity_route: {
    type: "approved_openai_connector_runtime",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  const parsed = JSON.parse(stream)
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("healthy-followup", structuredClone(base), 0, "automation_connector_catalog_verified")

const disabled = structuredClone(base)
disabled.turn.apps_instructions_after = false
disabled.connectors.registered_families = []
disabled.connectors.read_only_canary_passed = false
disabled.connectors.catalog_revision_readback = false
run("silent-disable", disabled, 75, "automation_followup_silently_disabled_apps")

const missingFamily = structuredClone(base)
missingFamily.connectors.registered_families = ["calendar"]
run("missing-family", missingFamily, 75, "required_connector_families_missing_after_followup")

const noCanary = structuredClone(base)
noCanary.connectors.read_only_canary_passed = false
run("read-canary", noCanary, 75, "connector_read_only_canary_required_after_followup")

const noRevision = structuredClone(base)
noRevision.connectors.catalog_revision_readback = false
run("catalog-revision", noRevision, 75, "connector_catalog_revision_not_verified")

const stale = structuredClone(base)
stale.turn.apps_instructions_after = false
stale.turn.explicit_apps_disable = true
stale.connectors.required_families = []
stale.connectors.registered_families = []
stale.state.stale_answer_accepted = true
run("reject-stale-answer", stale, 64, "stale_or_incomplete_answer_rejected_without_live_connectors")

const authMutation = structuredClone(stale)
authMutation.state.stale_answer_accepted = false
authMutation.connectors.oauth_reconnect_requested = true
run("preserve-auth", authMutation, 64, "connector_hydration_failure_must_not_trigger_auth_or_permission_mutation")

const replay = structuredClone(base)
replay.state.automatic_replay_requested = true
replay.state.external_writes_reconciled = false
run("reject-replay", replay, 64, "automation_replay_rejected_before_state_and_write_reconciliation")

const globalPause = structuredClone(stale)
globalPause.state.stale_answer_accepted = false
globalPause.state.unrelated_work_continues = false
run("avoid-global-pause", globalPause, 75, "unrelated_automation_work_should_not_be_globally_paused")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
