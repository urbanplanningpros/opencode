import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-openai-access-identity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-openai-access-identity-"))
const hash = "a".repeat(64)

const base = {
  operation_id: "op-1",
  account: {
    plan: "pro_20x",
    usage_multiplier: 20,
    shared_agentic_pool_acknowledged: true,
    capacity_policy_updated: true,
    legacy_pro_assumption_present: false,
  },
  sign_in_with_chatgpt: {
    used: true,
    external_app_id: "supabase",
    workspace_id: "workspace-1",
    identity_fields: ["name", "email", "profile_picture"],
    chatgpt_data_access_assumed: false,
    additional_permissions_requested: true,
    additional_permission_receipt_id: "permission-1",
    scope_sha256: hash,
    provider_authorization_separate: true,
    admin_application_approved: true,
  },
  connector: {
    action_requested: true,
    write_requested: true,
    connector_id: "supabase-1",
    operation_id: "connector-op-1",
    idempotency_key: "idem-1",
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

run("healthy-pro-and-connector", structuredClone(base), 0, "openai_access_and_identity_boundary_verified")

const mismatch = structuredClone(base)
mismatch.account.usage_multiplier = 5
run("pro-multiplier-mismatch", mismatch, 75, "openai_plan_multiplier_mismatch")

const legacy = structuredClone(base)
legacy.account.legacy_pro_assumption_present = true
run("legacy-plan-assumption", legacy, 75, "legacy_openai_plan_assumption_present")

const conflated = structuredClone(base)
conflated.sign_in_with_chatgpt.chatgpt_data_access_assumed = true
run("identity-conflated-with-data", conflated, 64, "sign_in_identity_must_not_imply_chatgpt_data_access")

const noPermission = structuredClone(base)
noPermission.sign_in_with_chatgpt.additional_permission_receipt_id = ""
run("missing-permission-receipt", noPermission, 64, "connector_authorization_separate_receipt_required")

const noIdempotency = structuredClone(base)
noIdempotency.connector.idempotency_key = ""
run("write-binding-incomplete", noIdempotency, 64, "connector_operation_binding_incomplete")

const prohibited = structuredClone(base)
prohibited.connector.route = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 7 }, null, 2))
