#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-scheduled-host-affinity-continuity-guard.mjs"

const approvedAppRoute = {
  type: "direct_openai_app_server",
  verified: true,
  canary_passed: true,
  operation_binding_matches: true,
  pinned_openai_model: true,
  excluded_provider_dependency_absent: true,
  model_gateway_present: false,
  automatic_model_selection_enabled: false,
}

const approvedRemoteRoute = {
  ...approvedAppRoute,
  type: "approved_ssh_remote_openai",
}

const reconciledState = {
  repository_writes_reconciled: true,
  connector_writes_reconciled: true,
  deployment_writes_reconciled: true,
  external_write_ledger_reconciled: true,
}

const scheduledBase = {
  mode: "scheduled_background_tool_continuity",
  operation_id: "op-scheduled-1",
  continuity_route: approvedAppRoute,
  state: reconciledState,
  identity: {
    schedule_id: "schedule-1",
    thread_id: "thread-1",
    turn_id: "turn-1",
    tool_call_id: "tool-1",
    schedule_definition_sha256: "sha-schedule",
    task_prompt_sha256: "sha-prompt",
  },
  observed: {
    scheduled_task_active: true,
    app_owned_tool_requested: true,
    tool_start_missing: true,
    no_visible_error_or_approval: true,
    foreground_open_triggered_resume: true,
  },
  requested_action: {},
  recovery: {},
}

const hostBase = {
  mode: "remote_project_host_affinity",
  operation_id: "op-host-1",
  continuity_route: approvedRemoteRoute,
  state: reconciledState,
  expected_destination: {
    project_id: "project-remote",
    host_id: "ssh-linux-1",
    canonical_worktree: "/srv/worktrees/op-host-1",
    starting_commit_sha: "abc123",
    idempotency_key: "idem-host-1",
  },
  actual_destination: {},
  observed: {
    project_scoped_create_hung: true,
    thread_management_calls_hung: true,
    no_structured_timeout_or_result: true,
  },
  requested_action: {},
  recovery: {},
}

const scheduledContained = {
  duplicate_wake_suppressed: true,
  side_effect_status_read_back: true,
  same_thread_resume_attempted: true,
  operation_id_preserved: true,
  idempotency_key_preserved: true,
  only_unfinished_tool_segment_authorized: true,
}

const hostContained = {
  side_effect_unknown_state_resolved: true,
  exact_task_registry_readback_complete: true,
  duplicate_creation_suppressed: true,
  child_mutations_blocked_until_validation: true,
  operation_id_and_idempotency_key_preserved: true,
}

const fixtures = [
  {
    name: "rejects missing operation id",
    evidence: { mode: "scheduled_background_tool_continuity" },
    admitted: false,
    reason: "malformed_evidence",
  },
  {
    name: "rejects gateway routing",
    evidence: {
      ...scheduledBase,
      continuity_route: { ...approvedAppRoute, model_gateway_present: true },
    },
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "rejects automatic model selection",
    evidence: {
      ...hostBase,
      continuity_route: { ...approvedRemoteRoute, automatic_model_selection_enabled: true },
    },
    admitted: false,
    reason: "route_authority_invalid",
  },
  {
    name: "healthy scheduled path continues",
    evidence: {
      ...scheduledBase,
      observed: {},
    },
    admitted: true,
    reason: "scheduled_background_path_healthy",
  },
  {
    name: "rejects duplicate scheduled task",
    evidence: {
      ...scheduledBase,
      requested_action: { start_duplicate_task: true },
    },
    admitted: false,
    reason: "unsafe_scheduled_retry_rejected",
  },
  {
    name: "requires scheduled identity receipt",
    evidence: {
      ...scheduledBase,
      identity: {},
    },
    admitted: false,
    reason: "scheduled_identity_receipt_required",
  },
  {
    name: "requires scheduled containment",
    evidence: scheduledBase,
    admitted: false,
    reason: "scheduled_containment_required",
  },
  {
    name: "admits same-thread scheduled resume",
    evidence: {
      ...scheduledBase,
      recovery: {
        ...scheduledContained,
        continuity_method: "same_thread_resume",
      },
    },
    admitted: true,
    reason: "scheduled_background_stall_contained",
  },
  {
    name: "rejects incomplete bounded tool reroute",
    evidence: {
      ...scheduledBase,
      recovery: {
        ...scheduledContained,
        continuity_method: "bounded_equivalent_tool_reroute",
      },
    },
    admitted: false,
    reason: "bounded_tool_reroute_incomplete",
  },
  {
    name: "admits bounded tool reroute",
    evidence: {
      ...scheduledBase,
      recovery: {
        ...scheduledContained,
        continuity_method: "bounded_equivalent_tool_reroute",
        original_tool_confirmed_not_started: true,
        equivalent_tool_semantics_verified: true,
        output_receipt_bound_to_original_tool_call: true,
        allowed_side_effects: ["read_repository", "write_target_file"],
        side_effect_scope_matches_original: true,
      },
    },
    admitted: true,
    reason: "scheduled_background_stall_contained",
  },
  {
    name: "rejects premature background restoration",
    evidence: {
      ...scheduledBase,
      recovery: {
        ...scheduledContained,
        continuity_method: "same_thread_resume",
        background_authority_restored: true,
      },
    },
    admitted: false,
    reason: "premature_background_authority_restore",
  },
  {
    name: "admits background restoration after canaries",
    evidence: {
      ...scheduledBase,
      recovery: {
        ...scheduledContained,
        continuity_method: "same_thread_resume",
        background_authority_restored: true,
        three_consecutive_background_canaries_passed: true,
        canaries_completed_without_opening_thread: true,
        tool_dispatch_started_within_deadline: true,
        terminal_receipts_persisted: true,
        no_duplicate_wakes_observed: true,
      },
    },
    admitted: true,
    reason: "scheduled_background_stall_contained",
  },
  {
    name: "healthy remote project route continues",
    evidence: {
      ...hostBase,
      observed: {},
      requested_action: {},
    },
    admitted: true,
    reason: "remote_project_route_healthy",
  },
  {
    name: "requires destination preflight before healthy child mutations",
    evidence: {
      ...hostBase,
      observed: {},
      requested_action: { enable_child_mutations: true },
    },
    admitted: false,
    reason: "destination_preflight_required",
  },
  {
    name: "rejects projectless repository fallback",
    evidence: {
      ...hostBase,
      requested_action: { fallback_to_projectless_for_repository_work: true },
    },
    admitted: false,
    reason: "unsafe_host_fallback_rejected",
  },
  {
    name: "requires expected destination manifest",
    evidence: {
      ...hostBase,
      expected_destination: {},
    },
    admitted: false,
    reason: "expected_destination_manifest_required",
  },
  {
    name: "requires host-affinity containment",
    evidence: hostBase,
    admitted: false,
    reason: "host_affinity_containment_required",
  },
  {
    name: "requires wrong-host child quarantine",
    evidence: {
      ...hostBase,
      observed: {
        ...hostBase.observed,
        child_created_on_wrong_host: true,
        project_identity_lost: true,
      },
      actual_destination: {
        host_id: "local-windows",
      },
      recovery: {
        ...hostContained,
        continuity_method: "verified_parent_executes",
      },
    },
    admitted: false,
    reason: "wrong_destination_quarantine_required",
  },
  {
    name: "admits parent continuity after wrong-host quarantine",
    evidence: {
      ...hostBase,
      observed: {
        ...hostBase.observed,
        child_created_on_wrong_host: true,
        project_identity_lost: true,
      },
      actual_destination: {
        host_id: "local-windows",
      },
      recovery: {
        ...hostContained,
        wrong_destination_child_quarantined: true,
        wrong_destination_writes_reconciled: true,
        wrong_destination_child_cancelled_or_read_only: true,
        projectless_retry_disabled: true,
        continuity_method: "verified_parent_executes",
      },
    },
    admitted: true,
    reason: "remote_host_affinity_failure_contained",
  },
  {
    name: "rejects incomplete project-scoped retry",
    evidence: {
      ...hostBase,
      recovery: {
        ...hostContained,
        continuity_method: "explicit_project_scoped_retry",
      },
    },
    admitted: false,
    reason: "project_scoped_retry_incomplete",
  },
  {
    name: "admits verified project-scoped retry",
    evidence: {
      ...hostBase,
      recovery: {
        ...hostContained,
        continuity_method: "explicit_project_scoped_retry",
        previous_request_confirmed_terminal_or_absent: true,
        explicit_project_id_used: true,
        explicit_host_id_used: true,
        exact_worktree_used: true,
        child_destination_verified: true,
        project_identity_verified: true,
        worktree_identity_verified: true,
        starting_commit_verified: true,
      },
    },
    admitted: true,
    reason: "remote_host_affinity_failure_contained",
  },
  {
    name: "rejects incomplete direct remote route",
    evidence: {
      ...hostBase,
      recovery: {
        ...hostContained,
        continuity_method: "direct_remote_app_server",
      },
    },
    admitted: false,
    reason: "remote_route_binding_incomplete",
  },
  {
    name: "admits direct remote route",
    evidence: {
      ...hostBase,
      recovery: {
        ...hostContained,
        continuity_method: "direct_remote_app_server",
        route_executes_on_expected_host: true,
        route_uses_expected_worktree: true,
        route_starting_commit_matches: true,
        output_reconciled_to_original_operation: true,
      },
    },
    admitted: true,
    reason: "remote_host_affinity_failure_contained",
  },
  {
    name: "rejects premature thread bridge restoration",
    evidence: {
      ...hostBase,
      recovery: {
        ...hostContained,
        continuity_method: "verified_parent_executes",
        thread_bridge_authority_restored: true,
      },
    },
    admitted: false,
    reason: "premature_thread_bridge_restore",
  },
  {
    name: "admits thread bridge restoration after canaries",
    evidence: {
      ...hostBase,
      recovery: {
        ...hostContained,
        continuity_method: "verified_parent_executes",
        thread_bridge_authority_restored: true,
        three_consecutive_project_create_canaries_passed: true,
        structured_timeout_canary_passed: true,
        idempotent_retry_canary_passed: true,
        host_project_worktree_receipts_match: true,
        projectless_repository_fallback_rejected_by_host: true,
      },
    },
    admitted: true,
    reason: "remote_host_affinity_failure_contained",
  },
]

for (const fixture of fixtures) {
  const actual = evaluate(fixture.evidence)
  assert.equal(actual.admitted, fixture.admitted, fixture.name)
  assert.equal(actual.reason, fixture.reason, fixture.name)
}

process.stdout.write(`ok ${fixtures.length} fixtures\n`)
