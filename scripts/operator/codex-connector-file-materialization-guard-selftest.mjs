import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-connector-file-materialization-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-connector-file-"))

const base = {
  operation_id: "op-file-1",
  source: {
    reference_type: "file_uri",
    reference_present: true,
    opaque_reference: true,
    authorized: true,
    tenant_binding_verified: true,
    credentials_exposed: false,
    signed_url_exposed: false,
    inline_base64_used: false,
    guessed_uri_conversion: false,
    arbitrary_provider_url_used: false,
    source_modified: false,
  },
  transfer: {
    consumer_contract_available: true,
    destination_root: "C:/workspace",
    destination_path: "C:/workspace/input.bin",
    inside_workspace_after_symlink_resolution: true,
    private_temp_used: true,
    atomic_rename: true,
    overwrite_requested: false,
    size_bytes_readback: true,
    sha256_readback: true,
    integrity_verified: true,
    cancellation_bounded: true,
    orphan_cleanup_verified: true,
    local_path_readable: true,
  },
  retry: {
    idempotency_key_present: true,
    same_key_same_args_reuses_artifact: true,
    same_key_different_args_conflicts: true,
  },
  state: {
    task_state_preserved: true,
    external_writes_reconciled: true,
    local_parser_started: false,
    automatic_replay_requested: false,
    unrelated_work_continues: true,
  },
  continuity_route: {
    type: "direct_openai_connector_materializer",
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

run("healthy", structuredClone(base), 0, "connector_file_materialization_verified")

const unsafe = structuredClone(base)
unsafe.source.inline_base64_used = true
run("reject-base64", unsafe, 64, "unsafe_connector_file_transport_rejected")

const noAuthority = structuredClone(base)
noAuthority.source.tenant_binding_verified = false
run("require-authority", noAuthority, 64, "connector_reference_authorization_or_tenant_binding_missing")

const noConsumer = structuredClone(base)
noConsumer.transfer.consumer_contract_available = false
noConsumer.transfer.local_path_readable = false
run("no-materializer", noConsumer, 75, "opaque_connector_reference_has_no_workspace_materializer")

const badDestination = structuredClone(base)
badDestination.transfer.inside_workspace_after_symlink_resolution = false
run("destination-boundary", badDestination, 64, "materialization_destination_not_safely_bound")

const noIdempotency = structuredClone(base)
noIdempotency.retry.idempotency_key_present = false
run("idempotency", noIdempotency, 75, "materialization_retry_semantics_not_idempotent")

const incomplete = structuredClone(base)
incomplete.transfer.integrity_verified = false
run("integrity", incomplete, 75, "materialized_file_integrity_or_cleanup_receipt_incomplete")

const parserEarly = structuredClone(incomplete)
parserEarly.state.local_parser_started = true
run("parser-early", parserEarly, 64, "local_parser_started_before_materialization_verification")

const replay = structuredClone(base)
replay.state.automatic_replay_requested = true
replay.state.external_writes_reconciled = false
run("reject-replay", replay, 64, "materialization_replay_rejected_before_reconciliation")

const prohibited = structuredClone(base)
prohibited.continuity_route.type = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 10 }, null, 2))
