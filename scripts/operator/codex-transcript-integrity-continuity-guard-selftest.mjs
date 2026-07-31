#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-transcript-integrity-continuity-guard.mjs"

const base = () => ({
  operation_id: "op-36358",
  mode: "tui_transcript_integrity",
  state: {
    task_state_checkpointed: true,
    repository_writes_reconciled: true,
    connector_writes_reconciled: true,
    deployment_writes_reconciled: true,
    external_write_ledger_reconciled: true,
  },
  continuity_route: {
    type: "direct_openai_app_server",
    verified: true,
    canary_passed: true,
    operation_binding_matches: true,
    pinned_openai_model: true,
    excluded_provider_dependency_absent: true,
    model_gateway_present: false,
    automatic_model_selection_enabled: false,
    excluded_provider_dependency_present: false,
    copilot_auto_selection_present: false,
    bedrock_present: false,
    vertex_present: false,
  },
})

const affected = () => ({
  ...base(),
  observed: {
    surface: "codex_cli_tui",
    visible_assistant_content_missing: true,
    prior_response_changed_after_reply: true,
  },
  recovery: {
    exact_thread_id_verified: true,
    exact_rollout_path_verified: true,
    immutable_rollout_copy_created: true,
    rollout_sha256_verified: true,
    canonical_message_item_id_recorded: true,
    canonical_message_hash_recorded: true,
    persisted_message_content_complete: true,
    app_server_readback_matches_rollout: true,
    decision_inputs_rebound_to_canonical_receipt: true,
    session_continued_without_task_replay: true,
    only_unverified_visible_segment_quarantined: true,
    tui_authority_restored: false,
    thread_id: "019f-example",
    canonical_message_item_id: "msg-example",
    canonical_message_hash: "sha256:abc",
  },
})

const cases = [
  {
    name: "rejects missing operation id",
    evidence: { mode: "tui_transcript_integrity" },
    admitted: false,
    reason: "malformed_evidence",
  },
  {
    name: "healthy transcript is admitted",
    evidence: { ...base(), observed: { surface: "codex_cli_tui" } },
    admitted: true,
    reason: "transcript_rendering_not_affected",
  },
  {
    name: "rejects broad operator pause",
    evidence: (() => { const x = affected(); x.state.broad_operator_pause_requested = true; return x })(),
    admitted: false,
    reason: "broad_containment_rejected",
  },
  {
    name: "rejects replay of completed mutations",
    evidence: (() => { const x = affected(); x.requested_action = { replay_completed_mutations: true }; return x })(),
    admitted: false,
    reason: "unsafe_replay_rejected",
  },
  {
    name: "rejects deleting session state",
    evidence: (() => { const x = affected(); x.requested_action = { delete_session_state: true }; return x })(),
    admitted: false,
    reason: "destructive_or_unverified_recovery_rejected",
  },
  {
    name: "rejects trusting visible scrollback",
    evidence: (() => { const x = affected(); x.requested_action = { approve_based_only_on_scrollback: true }; return x })(),
    admitted: false,
    reason: "visible_transcript_authority_rejected",
  },
  {
    name: "requires state reconciliation",
    evidence: (() => { const x = affected(); x.state.external_write_ledger_reconciled = false; return x })(),
    admitted: false,
    reason: "state_reconciliation_required",
  },
  {
    name: "requires canonical rollout receipt",
    evidence: (() => { const x = affected(); x.recovery.immutable_rollout_copy_created = false; return x })(),
    admitted: false,
    reason: "canonical_receipt_required",
  },
  {
    name: "requires narrow containment when persistence is incomplete",
    evidence: (() => { const x = affected(); x.recovery.persisted_message_content_complete = false; return x })(),
    admitted: false,
    reason: "canonical_persistence_unverified",
  },
  {
    name: "returns reconstruction gate after narrow containment",
    evidence: (() => {
      const x = affected()
      x.recovery.persisted_message_content_complete = false
      x.recovery.only_dependent_mutations_withheld = true
      x.recovery.missing_segment_marked_unverified = true
      x.recovery.external_receipts_and_logs_preserved = true
      return x
    })(),
    admitted: false,
    reason: "canonical_content_reconstruction_required",
  },
  {
    name: "rejects unapproved route",
    evidence: (() => { const x = affected(); x.continuity_route.type = "model_gateway"; return x })(),
    admitted: false,
    reason: "unapproved_continuity_route",
  },
  {
    name: "rejects excluded dependency",
    evidence: (() => { const x = affected(); x.continuity_route.excluded_provider_dependency_present = true; return x })(),
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "rejects automatic model selection",
    evidence: (() => { const x = affected(); x.continuity_route.automatic_model_selection_enabled = true; return x })(),
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "admits canonical persisted receipt continuity",
    evidence: affected(),
    admitted: true,
    reason: "transcript_rendering_failure_contained",
  },
  {
    name: "rejects premature TUI authority restore",
    evidence: (() => { const x = affected(); x.recovery.tui_authority_restored = true; return x })(),
    admitted: false,
    reason: "premature_tui_authority_restore",
  },
  {
    name: "admits TUI restore after all canaries",
    evidence: (() => {
      const x = affected()
      x.recovery.tui_authority_restored = true
      x.recovery.two_consecutive_full_render_canaries_passed = true
      x.recovery.copy_paste_scroll_canary_passed = true
      x.recovery.resume_replay_canary_passed = true
      x.recovery.rendered_hash_matches_canonical_hash = true
      return x
    })(),
    admitted: true,
    reason: "transcript_rendering_failure_contained",
  },
  {
    name: "rejects unsupported mode",
    evidence: { ...base(), mode: "unknown" },
    admitted: false,
    reason: "unsupported_mode",
  },
]

for (const fixture of cases) {
  const result = evaluate(fixture.evidence)
  assert.equal(result.admitted, fixture.admitted, fixture.name)
  assert.equal(result.reason, fixture.reason, fixture.name)
}

console.log(`passed ${cases.length} deterministic fixtures`)
