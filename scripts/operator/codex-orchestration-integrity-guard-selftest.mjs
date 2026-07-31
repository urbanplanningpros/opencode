#!/usr/bin/env node

import assert from "node:assert/strict"
import { evaluate } from "./codex-orchestration-integrity-guard.mjs"

const route = {
  type: "direct_openai_cli",
  verified: true,
  canary_passed: true,
  operation_binding_matches: true,
  workspace_state_verified: true,
  pinned_openai_model: true,
  automatic_model_selection_disabled: true,
  prohibited_dependency_absent: true,
}

const state = {
  task_state_checkpointed: true,
  repository_writes_reconciled: true,
  connector_writes_reconciled: true,
  deployment_writes_reconciled: true,
}

const cases = [
  {
    name: "rejects missing operation identity",
    evidence: { mode: "thread_create" },
    admitted: false,
    reason: "malformed_evidence",
  },
  {
    name: "rejects unapproved route",
    evidence: {
      operation_id: "op-1",
      mode: "usage_window",
      continuity_route: { type: "automatic_gateway" },
    },
    admitted: false,
    reason: "unapproved_continuity_route",
  },
  {
    name: "requires thread request identity",
    evidence: {
      operation_id: "op-2",
      mode: "thread_create",
      request: { model_pinned: true },
    },
    admitted: false,
    reason: "thread_create_identity_missing",
  },
  {
    name: "suppresses opaque desktop replay",
    evidence: {
      operation_id: "op-3",
      mode: "thread_create",
      state,
      continuity_route: route,
      request: {
        idempotency_key: "key-3",
        fingerprint: "sha256:3",
        model_pinned: true,
        automatic_model_selection_enabled: false,
      },
      observed: { status: "invalid_arguments" },
      reconciliation: {
        list_threads_checked: true,
        worktree_inventory_checked: true,
        project_registry_checked: true,
        repository_head_recorded: true,
        working_tree_recorded: true,
        no_new_thread_confirmed: true,
        no_new_worktree_confirmed: true,
      },
      requested_action: { retry_desktop_create_thread: true },
    },
    admitted: false,
    reason: "opaque_thread_create_retry_suppressed",
  },
  {
    name: "admits verified explicit worktree fallback",
    evidence: {
      operation_id: "op-4",
      mode: "thread_create",
      state,
      continuity_route: route,
      request: {
        idempotency_key: "key-4",
        fingerprint: "sha256:4",
        model_pinned: true,
        automatic_model_selection_enabled: false,
      },
      observed: { status: "invalid_arguments" },
      reconciliation: {
        list_threads_checked: true,
        worktree_inventory_checked: true,
        project_registry_checked: true,
        repository_head_recorded: true,
        working_tree_recorded: true,
        no_new_thread_confirmed: true,
        no_new_worktree_confirmed: true,
      },
      requested_action: { continue_with_explicit_worktree: true },
      explicit_worktree: {
        created_once: true,
        branch_identity_verified: true,
        worktree_list_verified: true,
        repository_head_verified: true,
        working_tree_verified: true,
        operation_receipt_written: true,
      },
    },
    admitted: true,
    reason: "thread_create_failure_contained",
  },
  {
    name: "suppresses duplicate hidden subagent",
    evidence: {
      operation_id: "op-5",
      mode: "subagent_observability",
      child: { created_receipt_present: true, thread_id: "child-5", status: "running" },
      ui: { subagents_panel_visible: false },
      requested_action: { spawn_additional_subagent: true },
    },
    admitted: false,
    reason: "additional_subagent_spawn_suppressed",
  },
  {
    name: "blocks parent completion with live hidden child",
    evidence: {
      operation_id: "op-6",
      mode: "subagent_observability",
      child: { created_receipt_present: true, thread_id: "child-6", status: "running" },
      ui: { subagents_panel_visible: false },
      requested_action: { complete_parent: true },
    },
    admitted: false,
    reason: "parent_completion_blocked_by_unreconciled_child",
  },
  {
    name: "admits hidden child with direct readback and reconciled writes",
    evidence: {
      operation_id: "op-7",
      mode: "subagent_observability",
      state,
      child: {
        created_receipt_present: true,
        thread_id: "child-7",
        status: "running",
        status_readback_available: true,
        status_readback_operation_bound: true,
        thread_identity_verified: true,
      },
      ui: { subagents_panel_visible: false },
      requested_action: {},
    },
    admitted: true,
    reason: "hidden_subagent_contained",
  },
  {
    name: "rejects incomplete usage evidence",
    evidence: {
      operation_id: "op-8",
      mode: "usage_window",
      window: { unexpected_reset_anchor_change: true },
    },
    admitted: false,
    reason: "usage_window_evidence_incomplete",
  },
  {
    name: "suppresses unbounded job during quota anomaly",
    evidence: {
      operation_id: "op-9",
      mode: "usage_window",
      window: {
        unexpected_reset_anchor_change: true,
        plan_type: "pro",
        window_minutes: 10080,
        resets_at: "2026-08-06T13:10:00Z",
        used_percent: 77,
        telemetry_snapshot_preserved: true,
      },
      requested_action: { start_new_unbounded_subscription_job: true },
    },
    admitted: false,
    reason: "unbounded_subscription_job_suppressed",
  },
  {
    name: "admits bounded essential continuity during quota anomaly",
    evidence: {
      operation_id: "op-10",
      mode: "usage_window",
      state,
      continuity_route: route,
      window: {
        past_due_window_still_accumulating: true,
        plan_type: "pro",
        window_minutes: 10080,
        resets_at: "2026-08-06T13:10:00Z",
        used_percent: 88,
        telemetry_snapshot_preserved: true,
      },
      requested_action: {
        essential_work_only: true,
        token_budget_cap_set: true,
        checkpoint_interval_set: true,
        usage_readback_after_each_checkpoint: true,
      },
    },
    admitted: true,
    reason: "usage_window_anomaly_contained",
  },
  {
    name: "blocks premature restoration of subscription-heavy queue",
    evidence: {
      operation_id: "op-11",
      mode: "usage_window",
      state,
      continuity_route: route,
      window: {
        reset_credit_consumed: true,
        capacity_ratio_to_prior: 0.4,
        plan_type: "pro",
        window_minutes: 10080,
        resets_at: "2026-08-06T13:10:00Z",
        used_percent: 1,
        telemetry_snapshot_preserved: true,
      },
      requested_action: {
        essential_work_only: true,
        token_budget_cap_set: true,
        checkpoint_interval_set: true,
        usage_readback_after_each_checkpoint: true,
        restore_subscription_heavy_queue: true,
      },
    },
    admitted: false,
    reason: "subscription_heavy_queue_restore_blocked",
  },
]

for (const testCase of cases) {
  const actual = evaluate(testCase.evidence)
  assert.equal(actual.admitted, testCase.admitted, `${testCase.name}: admitted`)
  assert.equal(actual.reason, testCase.reason, `${testCase.name}: reason`)
}

process.stdout.write(`passed ${cases.length} deterministic fixtures\n`)
