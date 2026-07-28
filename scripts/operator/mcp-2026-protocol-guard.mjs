import fs from "node:fs"
import path from "node:path"

const APPROVED_PROTOCOLS = new Set(["2025-11-25", "2026-07-28"])
const SUPPORTED_LEGACY_PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"])
const MODERN_PROTOCOL = "2026-07-28"
const LEGACY_PREVALIDATION_ERROR_CODE = -32000
const PROHIBITED_ROUTE_PATTERN = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway)/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const DATE_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) {
      parsed._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      parsed[key] = true
      continue
    }
    parsed[key] = next
    index += 1
  }
  return parsed
}

function readInput(args) {
  const file = args.input
  const text = file ? fs.readFileSync(path.resolve(file), "utf8") : fs.readFileSync(0, "utf8")
  if (!text.trim()) throw new Error("a JSON protocol plan is required on stdin or through --input")
  return JSON.parse(text)
}

function uniqueStrings(value, field, failures) {
  if (!Array.isArray(value)) {
    failures.push(`${field} must be an array`)
    return []
  }
  const result = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      failures.push(`${field} must contain non-empty strings`)
      continue
    }
    const normalized = item.trim()
    if (seen.has(normalized)) {
      failures.push(`${field} repeats '${normalized}'`)
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function requireSha(value, field, failures) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    failures.push(`${field} must be a SHA-256 hex digest`)
  }
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, output)
  return output
}

function validateLocalServer(server, failures) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    failures.push("server must be an object")
    return
  }
  if (server.route !== "local") {
    failures.push("server.route must be 'local'; remote MCP routes require separate explicit authorization")
  }
  if (server.transport !== "stdio") failures.push("server.transport must be 'stdio' for the approved local route")
  if (!Array.isArray(server.command) || server.command.length === 0) {
    failures.push("server.command must be a non-empty argument array")
  } else {
    if (server.command.some((part) => typeof part !== "string" || part.length === 0)) {
      failures.push("server.command must contain only non-empty strings")
    }
    const executable = server.command[0]
    if (typeof executable === "string" && !path.isAbsolute(executable)) {
      failures.push("server.command[0] must be an absolute executable path")
    }
  }
  requireSha(server.identity_sha256, "server.identity_sha256", failures)
}

function parseAdvertisedLegacyVersions(message) {
  const prefixes = [
    "Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: ",
    "Bad Request: Unsupported protocol version (supported versions: ",
  ]
  const prefix = prefixes.find((candidate) => message.startsWith(candidate))
  if (!prefix || !message.endsWith(")")) return null
  return message
    .slice(prefix.length, -1)
    .split(",")
    .map((version) => version.trim())
    .filter(Boolean)
}

function validateLegacyFallback(fallback, requestedProtocol, environment, failures) {
  if (fallback === undefined) {
    return { requested: false, allowed: false, effectiveProtocol: requestedProtocol, advertisedVersions: [] }
  }
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
    failures.push("discovery.legacy_fallback must be an object when present")
    return { requested: true, allowed: false, effectiveProtocol: requestedProtocol, advertisedVersions: [] }
  }
  if (fallback.requested !== true) {
    failures.push("discovery.legacy_fallback.requested must be true when the fallback object is present")
  }
  if (requestedProtocol !== MODERN_PROTOCOL || environment !== "canary") {
    failures.push("legacy discovery fallback is allowed only from an MCP 2026-07-28 canary")
  }
  if (fallback.same_server_identity !== true) failures.push("legacy fallback requires the exact reviewed server identity")
  if (fallback.http_status !== 400) failures.push("legacy fallback requires HTTP status 400")
  if (fallback.response_id !== null) failures.push("legacy fallback requires an uncorrelated null JSON-RPC response ID")
  if (fallback.error_code !== LEGACY_PREVALIDATION_ERROR_CODE) failures.push("legacy fallback requires JSON-RPC error code -32000")
  if (typeof fallback.message !== "string" || fallback.message.length === 0) {
    failures.push("legacy fallback requires an exact error message")
  }

  const message = typeof fallback.message === "string" ? fallback.message : ""
  const missingSession = message === "Bad Request: No valid session ID provided"
  const advertisedVersions = parseAdvertisedLegacyVersions(message) ?? []
  const versionEvidence = advertisedVersions.length > 0
  const versionsAreDates = advertisedVersions.every((version) => DATE_VERSION_PATTERN.test(version))
  const onlyKnownLegacy = advertisedVersions.every((version) => SUPPORTED_LEGACY_PROTOCOLS.has(version))
  const includesSupportedLegacy = advertisedVersions.some((version) => SUPPORTED_LEGACY_PROTOCOLS.has(version))
  const evidenceAllowed = missingSession || (versionEvidence && versionsAreDates && onlyKnownLegacy && includesSupportedLegacy)

  if (!evidenceAllowed) {
    failures.push("legacy fallback evidence must be the exact missing-session error or an exclusively supported legacy-version list")
  }

  const negotiated = fallback.negotiated_protocol_version
  if (!SUPPORTED_LEGACY_PROTOCOLS.has(negotiated)) {
    failures.push("legacy fallback negotiated_protocol_version must be a supported legacy version")
  }
  if (versionEvidence && !advertisedVersions.includes(negotiated)) {
    failures.push("legacy fallback negotiated_protocol_version must appear in the advertised legacy-version list")
  }

  const allowed = evidenceAllowed
    && requestedProtocol === MODERN_PROTOCOL
    && environment === "canary"
    && fallback.same_server_identity === true
    && fallback.http_status === 400
    && fallback.response_id === null
    && fallback.error_code === LEGACY_PREVALIDATION_ERROR_CODE
    && SUPPORTED_LEGACY_PROTOCOLS.has(negotiated)
    && (!versionEvidence || advertisedVersions.includes(negotiated))

  return {
    requested: true,
    allowed,
    effectiveProtocol: allowed ? negotiated : requestedProtocol,
    advertisedVersions,
  }
}

function validatePlan(plan) {
  const failures = []
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { failures: ["protocol plan must be an object"] }

  const protocol = plan.protocol_version
  const environment = plan.environment
  if (!APPROVED_PROTOCOLS.has(protocol)) failures.push(`protocol_version '${protocol}' is not approved`)
  if (!new Set(["production", "canary"]).has(environment)) failures.push("environment must be 'production' or 'canary'")
  if (protocol === MODERN_PROTOCOL && environment !== "canary") {
    failures.push("MCP 2026-07-28 is canary-only until a stable Codex release and migration suite pass")
  }

  validateLocalServer(plan.server, failures)

  const capabilities = plan.capabilities
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    failures.push("capabilities must be an object")
  }
  const discoverySupported = capabilities?.discovery === true
  const tasksSupported = capabilities?.tasks === true
  if (protocol === MODERN_PROTOCOL && !discoverySupported) {
    failures.push("MCP 2026-07-28 requires explicit server discovery capability")
  }

  const allowlistedTools = uniqueStrings(plan.allowlists?.tools, "allowlists.tools", failures)
  const allowlistedSkills = uniqueStrings(plan.allowlists?.skills ?? [], "allowlists.skills", failures)
  const toolSet = new Set(allowlistedTools)
  const skillSet = new Set(allowlistedSkills)

  const discovery = plan.discovery
  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) {
    failures.push("discovery must be an object")
  }
  const fallback = validateLegacyFallback(discovery?.legacy_fallback, protocol, environment, failures)
  const effectiveProtocol = fallback.effectiveProtocol
  const discoveredTools = uniqueStrings(discovery?.tools ?? [], "discovery.tools", failures)
  const discoveredSkills = uniqueStrings(discovery?.skills ?? [], "discovery.skills", failures)
  const discoveredToolSet = new Set(discoveredTools)

  for (const tool of discoveredTools) {
    if (!toolSet.has(tool)) failures.push(`discovered tool '${tool}' is not exactly allowlisted`)
  }
  for (const skill of discoveredSkills) {
    if (!skillSet.has(skill)) failures.push(`discovered skill '${skill}' is not exactly allowlisted`)
  }
  if (discovery?.load_requested === true && effectiveProtocol !== MODERN_PROTOCOL) {
    failures.push("server/load is not valid after legacy initialization fallback")
  }
  if (discovery?.load_requested === true && protocol !== MODERN_PROTOCOL) {
    failures.push("server/load is only valid for the MCP 2026-07-28 canary path")
  }
  if (discovery?.load_requested === true && discoveredTools.length === 0 && discoveredSkills.length === 0) {
    failures.push("server/load requires a bounded discovered tool or skill set")
  }

  const pluginFeatures = plan.plugin_features
  let recommendationsEnabled = false
  let toolSuggestEnabled = false
  let installToolExposed = false
  if (pluginFeatures !== undefined) {
    if (!pluginFeatures || typeof pluginFeatures !== "object" || Array.isArray(pluginFeatures)) {
      failures.push("plugin_features must be an object when present")
    } else {
      recommendationsEnabled = pluginFeatures.recommended_plugins === true
      toolSuggestEnabled = pluginFeatures.tool_suggest === true
      installToolExposed = pluginFeatures.request_plugin_install_exposed === true
      if (recommendationsEnabled && (pluginFeatures.apps_enabled !== true || pluginFeatures.plugins_enabled !== true)) {
        failures.push("recommended_plugins requires apps_enabled=true and plugins_enabled=true")
      }
      if (toolSuggestEnabled) failures.push("tool_suggest must remain disabled in authoritative operator workflows")
      if (installToolExposed) failures.push("request_plugin_install must not be exposed to the model")
    }
  }

  const task = plan.task
  if (task?.enabled === true) {
    if (effectiveProtocol !== MODERN_PROTOCOL) failures.push("long-running MCP tasks are unavailable after legacy initialization fallback")
    if (protocol !== MODERN_PROTOCOL) failures.push("long-running MCP tasks require protocol 2026-07-28")
    if (!tasksSupported) failures.push("task.enabled requires negotiated Tasks capability")
    if (!new Set(["read", "write"]).has(task.mode)) failures.push("task.mode must be 'read' or 'write'")
    if (typeof task.operation_id !== "string" || task.operation_id.trim() === "") failures.push("task.operation_id is required")
    if (typeof task.idempotency_key !== "string" || task.idempotency_key.trim() === "") failures.push("task.idempotency_key is required")
    if (typeof task.tool !== "string" || !toolSet.has(task.tool)) failures.push("task.tool must be exactly allowlisted")
    if (!discoveredToolSet.has(task.tool)) failures.push("task.tool is missing from the valid discovered catalog")
    requireSha(task.arguments_sha256, "task.arguments_sha256", failures)

    if (task.mode === "write") {
      const verification = task.verification
      if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
        failures.push("write tasks require an independent verification object")
      } else {
        if (typeof verification.tool !== "string" || !toolSet.has(verification.tool)) {
          failures.push("task.verification.tool must be exactly allowlisted")
        }
        if (!discoveredToolSet.has(verification.tool)) failures.push("task.verification.tool is missing from the valid discovered catalog")
        if (verification.tool === task.tool) failures.push("task.verification.tool must differ from the write tool")
        requireSha(verification.expected_sha256, "task.verification.expected_sha256", failures)
      }
    }
  } else if (task && task.enabled !== false) {
    failures.push("task.enabled must be boolean when task is present")
  }

  const prohibited = collectStrings(plan).filter((value) => PROHIBITED_ROUTE_PATTERN.test(value))
  if (prohibited.length > 0) {
    failures.push("protocol plan contains an excluded provider, model gateway, or automatic-selection identifier")
  }

  return {
    failures,
    normalized: {
      requested_protocol_version: protocol,
      effective_protocol_version: effectiveProtocol,
      environment,
      server_route: plan.server?.route ?? null,
      server_transport: plan.server?.transport ?? null,
      server_identity_sha256: plan.server?.identity_sha256 ?? null,
      discovery_supported: discoverySupported,
      tasks_supported: tasksSupported,
      legacy_fallback_requested: fallback.requested,
      legacy_fallback_allowed: fallback.allowed,
      legacy_advertised_versions: fallback.advertisedVersions,
      discovered_tool_count: discoveredTools.length,
      discovered_skill_count: discoveredSkills.length,
      recommended_plugins_enabled: recommendationsEnabled,
      tool_suggest_enabled: toolSuggestEnabled,
      request_plugin_install_exposed: installToolExposed,
      task_enabled: task?.enabled === true,
      task_mode: task?.enabled === true ? task.mode : null,
      operation_id: task?.enabled === true ? task.operation_id : null,
    },
  }
}

const args = parseArgs(process.argv.slice(2))
let plan
try {
  plan = readInput(args)
} catch (error) {
  const report = { allowed: false, input_error: error.message }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.error(`MCP protocol guard input error: ${error.message}`)
  process.exit(2)
}

const { failures, normalized } = validatePlan(plan)
const report = {
  allowed: failures.length === 0,
  failures,
  normalized,
  policy: {
    production_protocol: "2025-11-25",
    canary_protocol: "2026-07-28",
    route: "explicitly authorized local stdio only",
    dynamic_discovery_authority: false,
    automatic_task_replay: false,
    legacy_fallback: "exact HTTP 400/null-ID/-32000 evidence from the same reviewed server only",
    plugin_recommendations: "display-only; tool_suggest and request_plugin_install disabled",
  },
}

if (args.json) console.log(JSON.stringify(report, null, 2))
else if (report.allowed) console.log("MCP protocol plan allowed")
else {
  console.error("MCP protocol plan rejected:")
  for (const failure of failures) console.error(`- ${failure}`)
}

process.exit(report.allowed ? 0 : 64)
