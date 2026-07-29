import fs from "node:fs"
import { nowIso, parseArgs, sha256 } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
const input = args.input
if (!input) {
  console.error("Usage: bun scripts/operator/codex-release-compatibility-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

const minimum = "0.145.0"
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

function version(value) {
  const match = String(value || "").trim().match(/^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return match.slice(1).map(Number)
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] === right[index]) continue
    return left[index] > right[index] ? 1 : -1
  }
  return 0
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

let evidence
try {
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(`Unable to read compatibility evidence: ${error.message}`)
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []
const floor = version(minimum)
const versions = {
  app_server: text(evidence.app_server_version),
  exec_server: text(evidence.exec_server_version),
}

for (const [role, raw] of Object.entries(versions)) {
  const parsed = version(raw)
  if (!parsed) {
    blocked.push(`${role}_version_invalid`)
    continue
  }
  if (compare(parsed, floor) < 0) remediation.push(`${role}_version_below_${minimum}`)
}

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
const routeReceipt = `${provider} ${route}`
if (!provider) blocked.push("routing_provider_missing")
if (prohibited.some((name) => routeReceipt.includes(name))) blocked.push("prohibited_provider_or_gateway")
if (routing.automatic_selector === true) blocked.push("automatic_selector_enabled")
if (routing.model_gateway === true) blocked.push("model_gateway_enabled")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("unapproved_provider")

const mcp = evidence.mcp || null
if (mcp) {
  const transport = text(mcp.transport).toLowerCase()
  const configured = text(mcp.configured_server_name)
  const discovered = text(mcp.discovered_server_name)
  const approvedHash = text(mcp.approved_tool_catalog_sha256).toLowerCase()
  const observedHash = text(mcp.observed_tool_catalog_sha256).toLowerCase()
  const writeAuthority = mcp.write_authority_requested === true

  if (!["stdio", "http", "sse"].includes(transport)) blocked.push("mcp_transport_invalid")
  if (!configured) blocked.push("mcp_configured_server_name_missing")
  if (!discovered) warnings.push("mcp_server_identity_missing_using_configured_name")
  if (approvedHash && !/^[a-f0-9]{64}$/.test(approvedHash)) blocked.push("approved_tool_catalog_hash_invalid")
  if (observedHash && !/^[a-f0-9]{64}$/.test(observedHash)) blocked.push("observed_tool_catalog_hash_invalid")
  if (writeAuthority && (!approvedHash || !observedHash)) blocked.push("tool_catalog_hash_required_for_write_authority")
  if (approvedHash && observedHash && approvedHash !== observedHash) blocked.push("mcp_tool_catalog_drift")

  const oauth = mcp.oauth || {}
  const status = text(oauth.status || "ok").toLowerCase()
  const retries = Number(oauth.retry_count || 0)
  const crossOrigin = oauth.cross_origin_redirect === true

  if (!Number.isInteger(retries) || retries < 0) blocked.push("oauth_retry_count_invalid")
  if (oauth.anonymous_fallback_requested === true) blocked.push("oauth_anonymous_fallback_requested")
  if (oauth.credential_reset_requested === true) blocked.push("oauth_credential_reset_requested")
  if (status === "transport_error" || status === "transient_http") {
    if (retries > 1) blocked.push("oauth_retry_budget_exceeded")
    else remediation.push("retry_same_endpoint_once_after_state_reconciliation")
  } else if (status === "redirect") {
    if (crossOrigin) blocked.push("oauth_cross_origin_redirect")
    else remediation.push("review_same_origin_redirect_before_retry")
  } else if (status === "unauthorized") {
    remediation.push("reauthenticate_exact_approved_connector")
  } else if (status !== "ok") {
    blocked.push("oauth_status_unknown")
  }
}

const status = blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible"
const result = {
  checked_at: nowIso(),
  status,
  minimum_supported_codex_version: minimum,
  versions,
  blocked,
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  evidence_sha256: sha256(JSON.stringify(evidence)),
  continuity_route: status === "compatible" ? "current approved route" : "approved OpenAI stable route or explicitly authorized local executor",
}

if (args.json) console.log(JSON.stringify(result))
else {
  console.log(`Codex release compatibility: ${status}`)
  console.log(`Version floor: ${minimum}; app-server ${versions.app_server}; exec-server ${versions.exec_server}`)
  if (blocked.length > 0) console.error(`Blocked: ${blocked.join(", ")}`)
  if (remediation.length > 0) console.error(`Remediation: ${[...new Set(remediation)].join(", ")}`)
  if (warnings.length > 0) console.error(`Warnings: ${[...new Set(warnings)].join(", ")}`)
}

if (blocked.length > 0) process.exit(64)
if (remediation.length > 0) process.exit(75)
process.exit(0)
