#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"

function parseArgs(values) {
  const args = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = values[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(text(value).toLowerCase())
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

const prohibited = [
  "anthropic",
  "claude",
  "manus",
  "openrouter",
  "litellm",
  "bedrock",
  "vertex",
  "copilot-auto",
  "model-gateway",
]

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error("Usage: node scripts/operator/codex-external-write-target-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

let evidence
try {
  evidence = JSON.parse(fs.readFileSync(args.input, "utf8"))
} catch (error) {
  console.error(`Unable to read external-write evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const routeReceipt = `${provider} ${route}`
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.some((name) => routeReceipt.includes(name))) blocked.push("prohibited_provider_or_gateway")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const operation = evidence.operation || {}
const operationClass = text(operation.class || "write").toLowerCase()
const operationId = text(operation.id)
const idempotencyKey = text(operation.idempotency_key)
const authorizedMutations = Array.isArray(operation.authorized_mutations)
  ? operation.authorized_mutations.map((value) => text(value).toLowerCase()).filter(Boolean)
  : []
const requestedMutations = Array.isArray(operation.requested_mutations)
  ? operation.requested_mutations.map((value) => text(value).toLowerCase()).filter(Boolean)
  : []

if (!operationId) blocked.push("operation_id_missing")
if (!idempotencyKey) blocked.push("idempotency_key_missing")
if (!new Set(["read", "write"]).has(operationClass)) blocked.push("operation_class_invalid")
if (operationClass === "write" && authorizedMutations.length === 0) blocked.push("authorized_mutations_missing")
for (const mutation of requestedMutations) {
  if (!authorizedMutations.includes(mutation)) blocked.push(`unauthorized_mutation:${mutation}`)
}

const target = evidence.target || {}
const configuredTargetId = text(target.configured_target_id)
const observedTargetId = text(target.observed_target_id)
const canonicalEndpoint = text(target.canonical_endpoint)
const parentState = text(target.parent_state || "unknown").toLowerCase()
const revisionState = text(target.revision_state || "unknown").toLowerCase()
const approvedStateHash = text(target.approved_target_state_sha256).toLowerCase()
const observedStateHash = text(target.observed_target_state_sha256).toLowerCase()
const preflightObservedAt = Date.parse(text(target.preflight_observed_at))
const writeDispatchedAt = Date.parse(text(target.write_dispatched_at))
const maxAgeSeconds = Number(target.preflight_max_age_seconds ?? 60)

if (!configuredTargetId) blocked.push("configured_target_id_missing")
if (!observedTargetId) remediation.push("read_authoritative_target_state_before_write")
if (configuredTargetId && observedTargetId && configuredTargetId !== observedTargetId) blocked.push("external_target_identity_mismatch")
if (!canonicalEndpoint) blocked.push("canonical_target_endpoint_missing")
if (!["published", "draft", "unpublished", "unknown"].includes(parentState)) blocked.push("parent_state_invalid")
if (!["published", "unpublished", "none", "unknown"].includes(revisionState)) blocked.push("revision_state_invalid")
if (parentState === "unknown" || revisionState === "unknown") remediation.push("resolve_parent_and_revision_state_before_write")
if (target.description_assumed_without_authoritative_read === true) blocked.push("user_description_cannot_replace_target_state_preflight")
if (target.write_dispatched_before_state_preflight === true) blocked.push("write_dispatched_before_target_state_preflight")

if (!isSha256(approvedStateHash)) remediation.push("capture_approved_target_state_hash")
if (!isSha256(observedStateHash)) remediation.push("capture_observed_target_state_hash")
if (isSha256(approvedStateHash) && isSha256(observedStateHash) && approvedStateHash !== observedStateHash) {
  blocked.push("external_target_state_changed_after_approval")
}

if (!Number.isFinite(preflightObservedAt)) remediation.push("record_authoritative_preflight_timestamp")
if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > 300) blocked.push("target_preflight_age_limit_invalid")
if (Number.isFinite(preflightObservedAt) && Number.isFinite(writeDispatchedAt)) {
  if (writeDispatchedAt < preflightObservedAt) blocked.push("write_timestamp_precedes_target_preflight")
  else if ((writeDispatchedAt - preflightObservedAt) / 1000 > maxAgeSeconds) remediation.push("refresh_stale_target_state_before_write")
}
if (operationClass === "write" && !Number.isFinite(writeDispatchedAt) && evidence.attempt?.status !== "not_started") {
  remediation.push("record_write_dispatch_timestamp")
}

const attempt = evidence.attempt || {}
const attemptStatus = text(attempt.status || "not_started").toLowerCase()
const allowedAttemptStatuses = new Set(["not_started", "failed_before_dispatch", "failed_after_dispatch", "unknown", "completed"])
if (!allowedAttemptStatuses.has(attemptStatus)) blocked.push("external_write_attempt_status_invalid")
if (["failed_after_dispatch", "unknown"].includes(attemptStatus) && attempt.durable_state_reconciled !== true) {
  blocked.push("external_write_side_effect_unknown_reconciliation_required")
}
if (attemptStatus === "completed" && attempt.post_write_verified !== true) {
  remediation.push("verify_external_destination_after_write")
}
if (attempt.retry_requested === true && !["not_started", "failed_before_dispatch"].includes(attemptStatus)) {
  blocked.push("external_write_retry_requires_proven_non_dispatch")
}

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: new Date().toISOString(),
  status,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  continuity_route:
    status === "compatible"
      ? "current approved route"
      : "pinned direct OpenAI control with explicitly authorized local write executor",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex external-write target boundary: ${status}`)
  if (result.blocked.length > 0) console.error(`Blocked: ${result.blocked.join(", ")}`)
  if (result.remediation.length > 0) console.error(`Remediation: ${result.remediation.join(", ")}`)
}

if (result.blocked.length > 0) process.exit(64)
if (result.remediation.length > 0) process.exit(75)
process.exit(0)
