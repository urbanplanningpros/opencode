#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-fork-voice-continuity-guard.mjs"

const approvedRoute = {
  type: "direct_openai_app_server",
  verified: true,
  canary_passed: true,
  operation_binding_matches: true,
  pinned_openai_model: true,
  excluded_provider_dependency_absent: true,
  model_gateway_present: false,
  automatic_model_selection_enabled: false,
}

const reconciledState = {
  repository_writes_reconciled: true,
  connector_writes_reconciled: true,
  deployment_writes_reconciled: true,
  external_write_ledger_reconciled: true,
}

const activeForkBase = {
  mode: "active_fork_boundary",
  operation_id: "op-fork-1",
  continuity_route: approvedRoute,
  state: reconciledState,
  source: {
    turn_in_progress: true,
    active_tool_call_present: true,
    latest_turn_status: "inProgress",
  },
  fork: {},
  requested_action: {},
  recovery: {},
}

const voiceBase = {
  mode: "realtime_voice_task_bridge",
  operation_id: "op-voice-1",
  continuity_route: approvedRoute,
  state: reconciledState,
  observed: {
    no_handler_registered: true,
    thread_list_unavailable: true,
    live_host_route_lost: true,
  },
  requested_action: {},
  recovery: {},
}

const fixtures = [
  {
    name: "rejects missing operation id",
    evidence: { mode: "active_fork_boundary" },
    admitted: false,
    reason: "malformed_evidence",
  },
  {
    name: "rejects automatic model selection",
    evidence: {
      ...activeForkBase,
      continuity_route: { ...approvedRoute, automatic_model_selection_enabled: true },
    },
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "rejects gateway routing",
    evidence: {
      ...voiceBase,
      continuity_route: { ...approvedRoute, model_gateway_present: true },
    },
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "rejects native fork during active turn",
    evidence: {
      ...activeForkBase,
      requested_action: { create_native_fork: true },
    },
    admitted: false,
    reason: "active_turn_fork_rejected",
  },
  {
    name: "requires contaminated child containment",
    evidence: {
      ...activeForkBase,
      fork: { child_contains_source_active_turn: true },
      recovery: { continuity_method: "parent_executes_mutation" },
    },
    admitted: false,
    reason: "contaminated_child_containment_required",
  },
  {
    name: "requires verified independent snapshot",
    evidence: {
      ...activeForkBase,
      fork: { child_contains_abandoned_instruction: true },
      recovery: {
        child_mutations_blocked: true,
        child_write_ledger_reconciled: true,
        contaminated_child_quarantined: true,
        duplicate_delegation_suppressed: true,
        continuity_method: "new_independent_thread_from_verified_snapshot",
      },
    },
    admitted: false,
    reason: "independent_thread_snapshot_incomplete",
  },
  {
    name: "admits contained independent thread recovery",
    evidence: {
      ...activeForkBase,
      fork: {
        child_contains_source_active_turn: true,
        inherited_turn_id_matches_active_source_turn: true,
      },
      recovery: {
        child_mutations_blocked: true,
        child_write_ledger_reconciled: true,
        contaminated_child_quarantined: true,
        duplicate_delegation_suppressed: true,
        continuity_method: "new_independent_thread_from_verified_snapshot",
        completed_history_snapshot_verified: true,
        completed_history_sha256: "abc123",
        active_source_turn_excluded: true,
        idempotency_registry_checked: true,
        new_thread_mutations_blocked_until_inspection: true,
        no_source_active_turn_ids_present: true,
      },
    },
    admitted: true,
    reason: "active_fork_contained",
  },
  {
    name: "admits parent mutation continuity",
    evidence: {
      ...activeForkBase,
      fork: { child_contains_partial_assistant_output: true },
      recovery: {
        child_mutations_blocked: true,
        child_write_ledger_reconciled: true,
        contaminated_child_quarantined: true,
        duplicate_delegation_suppressed: true,
        continuity_method: "parent_executes_mutation",
      },
    },
    admitted: true,
    reason: "active_fork_contained",
  },
  {
    name: "rejects blind voice create retry",
    evidence: {
      ...voiceBase,
      requested_action: { retry_create_thread_without_registry_readback: true },
    },
    admitted: false,
    reason: "unsafe_voice_retry_rejected",
  },
  {
    name: "requires exact voice registry reconciliation",
    evidence: voiceBase,
    admitted: false,
    reason: "voice_bridge_containment_required",
  },
  {
    name: "admits voice bridge reroute",
    evidence: {
      ...voiceBase,
      recovery: {
        voice_mutation_tools_disabled: true,
        exact_thread_uuid_registry_readback_complete: true,
        side_effecting_retry_suppressed: true,
        existing_child_status_reconciled: true,
        operation_id_and_idempotency_key_preserved: true,
      },
    },
    admitted: true,
    reason: "voice_bridge_failure_contained",
  },
  {
    name: "rejects premature voice authority restoration",
    evidence: {
      ...voiceBase,
      recovery: {
        voice_mutation_tools_disabled: true,
        exact_thread_uuid_registry_readback_complete: true,
        side_effecting_retry_suppressed: true,
        existing_child_status_reconciled: true,
        operation_id_and_idempotency_key_preserved: true,
        voice_mutation_authority_restored: true,
      },
    },
    admitted: false,
    reason: "premature_voice_authority_restore",
  },
  {
    name: "admits restored voice authority after canaries",
    evidence: {
      ...voiceBase,
      recovery: {
        voice_mutation_tools_disabled: true,
        exact_thread_uuid_registry_readback_complete: true,
        side_effecting_retry_suppressed: true,
        existing_child_status_reconciled: true,
        operation_id_and_idempotency_key_preserved: true,
        voice_mutation_authority_restored: true,
        three_consecutive_handler_canaries_passed: true,
        create_read_wait_message_fork_canary_passed: true,
        no_duplicate_thread_canary_passed: true,
        host_route_survived_child_completion_and_timeout: true,
      },
    },
    admitted: true,
    reason: "voice_bridge_failure_contained",
  },
  {
    name: "healthy voice bridge continues normally",
    evidence: {
      ...voiceBase,
      observed: {},
      recovery: {},
    },
    admitted: true,
    reason: "voice_bridge_healthy",
  },
]

for (const fixture of fixtures) {
  const actual = evaluate(fixture.evidence)
  assert.equal(actual.admitted, fixture.admitted, fixture.name)
  assert.equal(actual.reason, fixture.reason, fixture.name)
}

process.stdout.write(`ok ${fixtures.length} fixtures\n`)
