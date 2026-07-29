import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      index += 1
    } else out[key] = true
  }
  return out
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function nonNegativeInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error(JSON.stringify({ status: "invalid", reason: "missing_input" }))
  process.exit(2)
}

let evidence
try {
  const input = path.resolve(String(args.input))
  const stat = fs.lstatSync(input)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular non-symlink file")
  evidence = JSON.parse(fs.readFileSync(input, "utf8"))
} catch (error) {
  console.error(JSON.stringify({ status: "invalid", reason: "invalid_evidence", detail: error.message }))
  process.exit(2)
}

const prohibited = /(anthropic|claude|manus|openrouter|litellm|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i

const blocked = []
const remediation = []
const warnings = []

const routing = evidence.routing || {}
const provider = text(routing.provider).toLowerCase()
const route = text(routing.route).toLowerCase()
if (prohibited.test(`${provider} ${route}`)) blocked.push("prohibited_route_metadata")
if (!provider) blocked.push("routing_provider_missing")
if (provider && !["openai", "approved-local"].includes(provider)) blocked.push("routing_provider_not_approved")
if (!["direct", "authorized-local"].includes(route)) blocked.push("routing_path_not_pinned")
if (routing.automatic_selector === true || routing.model_gateway === true) blocked.push("automatic_routing_forbidden")

const pagination = evidence.mcp_catalog_pagination || null
if (pagination) {
  const pages = nonNegativeInteger(pagination.page_count)
  const items = nonNegativeInteger(pagination.item_count)
  const cursorBytes = nonNegativeInteger(pagination.maximum_cursor_bytes_observed)
  const timeoutSeconds = positiveNumber(pagination.overall_timeout_seconds)

  if (pages === null) blocked.push("mcp_page_count_invalid")
  else if (pages > 100) blocked.push("mcp_page_limit_exceeded")

  if (items === null) blocked.push("mcp_item_count_invalid")
  else if (items > 1_024) blocked.push("mcp_item_limit_exceeded")

  if (cursorBytes === null) blocked.push("mcp_cursor_size_invalid")
  else if (cursorBytes > 65_536) blocked.push("mcp_cursor_size_limit_exceeded")

  if (pagination.repeated_cursor_observed === true) blocked.push("mcp_repeated_cursor_observed")
  if (timeoutSeconds === null) remediation.push("set_bounded_mcp_catalog_timeout")
  if (pagination.limits_enforced !== true) remediation.push("enforce_mcp_catalog_limits_before_discovery")
  if (pagination.upstream_fix_in_pinned_stable !== true) warnings.push("upstream_mcp_pagination_fix_not_in_pinned_stable")
}

const network = evidence.network_policy_amendment || null
if (network) {
  const requestedHost = text(network.requested_host).toLowerCase()
  const amendmentHost = text(network.amendment_host).toLowerCase()
  const action = text(network.action).toLowerCase()
  const pendingOutcome = text(network.pending_request_outcome).toLowerCase()
  const callOutcome = text(network.owning_call_outcome).toLowerCase()
  const allowRequested = network.requested === true && action === "allow"
  const applied = network.applied === true

  if (network.requested === true && !["allow", "deny"].includes(action)) blocked.push("network_amendment_action_invalid")
  if (allowRequested && applied && requestedHost && amendmentHost && requestedHost !== amendmentHost) {
    blocked.push("network_amendment_host_mismatch")
  }
  if (allowRequested && !applied) {
    if (network.session_host_approved === true || pendingOutcome === "allow_for_session") {
      blocked.push("failed_network_amendment_granted_access")
    }
    if (pendingOutcome !== "deny") remediation.push("deny_request_after_failed_network_amendment")
    if (callOutcome !== "denied_by_policy") remediation.push("record_failed_amendment_as_policy_denial")
    warnings.push("upstream_network_amendment_fix_not_in_pinned_stable")
  }
}

const status = blocked.length ? "blocked" : remediation.length ? "remediation_required" : "compatible"
const report = {
  status,
  blocked: [...new Set(blocked)],
  remediation: [...new Set(remediation)],
  warnings: [...new Set(warnings)],
  policy: {
    mcp_max_pages: 100,
    mcp_max_items: 1_024,
    mcp_max_cursor_bytes: 65_536,
    failed_network_amendment_outcome: "deny",
  },
  evidence_sha256: crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  continuity_route: "pinned direct OpenAI or explicitly authorized local execution",
}

const output = JSON.stringify(report, null, 2)
if (status === "compatible" || args.json) console.log(output)
else console.error(output)
if (status === "blocked") process.exit(64)
if (status === "remediation_required") process.exit(75)
process.exit(0)
