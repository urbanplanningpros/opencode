import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular non-symlink file`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value.trim()
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`)
  return value
}

function optionalObject(value, name) {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

const args = parseArgs(process.argv.slice(2))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const sha256 = /^[a-f0-9]{64}$/i

if (!args.input) {
  console.error(JSON.stringify({ admitted: false, reason: "missing_input" }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = readJsonFile(path.resolve(String(args.input)))
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (prohibited.test(JSON.stringify(evidence))) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let operationId
let account
let signIn
let connector

try {
  operationId = nonEmptyString(evidence.operation_id, "operation_id")
  account = optionalObject(evidence.account, "account")
  signIn = optionalObject(evidence.sign_in_with_chatgpt, "sign_in_with_chatgpt")
  connector = optionalObject(evidence.connector, "connector")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "malformed_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

const plan = nonEmptyString(account.plan, "account.plan").toLowerCase()
const allowedPlans = new Set(["free", "go", "plus", "pro_5x", "pro_20x", "business", "edu", "enterprise", "api_key"])
if (!allowedPlans.has(plan)) {
  console.error(JSON.stringify({ admitted: false, reason: "unsupported_openai_access_plan" }, null, 2))
  process.exit(2)
}

const usageMultiplier = Number(account.usage_multiplier)
if (!Number.isFinite(usageMultiplier) || usageMultiplier <= 0) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_usage_multiplier" }, null, 2))
  process.exit(2)
}

const sharedPoolAcknowledged = boolean(account.shared_agentic_pool_acknowledged, "account.shared_agentic_pool_acknowledged")
const capacityPolicyUpdated = boolean(account.capacity_policy_updated, "account.capacity_policy_updated")
const legacyProAssumption = boolean(account.legacy_pro_assumption_present, "account.legacy_pro_assumption_present")
const planMultiplierMismatch = (plan === "pro_5x" && usageMultiplier !== 5) || (plan === "pro_20x" && usageMultiplier !== 20)

const signInUsed = boolean(signIn.used, "sign_in_with_chatgpt.used")
const externalAppId = optionalString(signIn.external_app_id, "sign_in_with_chatgpt.external_app_id")
const workspaceId = optionalString(signIn.workspace_id, "sign_in_with_chatgpt.workspace_id")
const identityFields = Array.isArray(signIn.identity_fields) ? signIn.identity_fields.map((value) => String(value).toLowerCase()) : []
const allowedIdentityFields = new Set(["name", "email", "profile_picture"])
const identityFieldsValid = identityFields.every((field) => allowedIdentityFields.has(field))
const chatgptDataAccessAssumed = boolean(signIn.chatgpt_data_access_assumed, "sign_in_with_chatgpt.chatgpt_data_access_assumed")
const additionalPermissionsRequested = boolean(
  signIn.additional_permissions_requested,
  "sign_in_with_chatgpt.additional_permissions_requested",
)
const permissionReceiptId = optionalString(
  signIn.additional_permission_receipt_id,
  "sign_in_with_chatgpt.additional_permission_receipt_id",
)
const scopeSha256 = optionalString(signIn.scope_sha256, "sign_in_with_chatgpt.scope_sha256")
const providerAuthorizationSeparate = boolean(
  signIn.provider_authorization_separate,
  "sign_in_with_chatgpt.provider_authorization_separate",
)
const adminApplicationApproved = boolean(signIn.admin_application_approved, "sign_in_with_chatgpt.admin_application_approved")

const connectorActionRequested = boolean(connector.action_requested, "connector.action_requested")
const connectorWriteRequested = boolean(connector.write_requested, "connector.write_requested")
const connectorId = optionalString(connector.connector_id, "connector.connector_id")
const connectorOperationId = optionalString(connector.operation_id, "connector.operation_id")
const idempotencyKey = optionalString(connector.idempotency_key, "connector.idempotency_key")

const permissionReceiptComplete =
  additionalPermissionsRequested &&
  Boolean(permissionReceiptId) &&
  sha256.test(scopeSha256) &&
  providerAuthorizationSeparate &&
  adminApplicationApproved

const connectorBindingComplete =
  !connectorActionRequested ||
  (Boolean(connectorId) && Boolean(connectorOperationId) && (!connectorWriteRequested || Boolean(idempotencyKey)))

let admitted = true
let reason = "openai_access_and_identity_boundary_verified"
let exitCode = 0

if (!sharedPoolAcknowledged || !capacityPolicyUpdated || legacyProAssumption || planMultiplierMismatch) {
  admitted = false
  reason = planMultiplierMismatch
    ? "openai_plan_multiplier_mismatch"
    : legacyProAssumption
      ? "legacy_openai_plan_assumption_present"
      : "shared_agentic_capacity_policy_not_updated"
  exitCode = 75
} else if (signInUsed && (!externalAppId || !workspaceId || !identityFieldsValid || chatgptDataAccessAssumed)) {
  admitted = false
  reason = chatgptDataAccessAssumed
    ? "sign_in_identity_must_not_imply_chatgpt_data_access"
    : "sign_in_identity_receipt_incomplete"
  exitCode = 64
} else if (connectorActionRequested && (!signInUsed || !permissionReceiptComplete || !connectorBindingComplete)) {
  admitted = false
  reason = !permissionReceiptComplete
    ? "connector_authorization_separate_receipt_required"
    : "connector_operation_binding_incomplete"
  exitCode = 64
}

const result = {
  admitted,
  reason,
  operation_id: operationId,
  plan,
  usage_multiplier: usageMultiplier,
  sign_in_used: signInUsed,
  connector_action_requested: connectorActionRequested,
  connector_write_requested: connectorWriteRequested,
}

const stream = admitted ? process.stdout : process.stderr
stream.write(`${JSON.stringify(result, null, 2)}\n`)
process.exit(exitCode)
