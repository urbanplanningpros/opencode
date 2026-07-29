import fs from "node:fs"

const argv = process.argv.slice(2)
const takeValue = (name) => {
  const index = argv.indexOf(name)
  if (index === -1 || !argv[index + 1]) return null
  const value = argv[index + 1]
  argv.splice(index, 2)
  return value
}
const takeFlag = (name) => {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}

const inputPath = takeValue("--input")
const jsonOutput = takeFlag("--json")
if (!inputPath || argv.length > 0) {
  console.error("Usage: node scripts/operator/codex-terminal-path-provenance-guard.mjs --input <evidence.json> [--json]")
  process.exit(2)
}

const evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"))
const supportedHosts = new Set(["linux", "darwin", "windows"])
if (!supportedHosts.has(evidence.host_platform) || !Array.isArray(evidence.terminals)) {
  console.error("Evidence requires host_platform=linux|darwin|windows and a terminals array")
  process.exit(2)
}

function encodePathSegments(value) {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function normalizeWindowsNamespace(raw) {
  const uncMatch = raw.match(/^\\\\[?.]\\UNC\\(.+)$/i)
  if (uncMatch) {
    const parts = uncMatch[1].split("\\")
    const server = parts.shift() || ""
    const share = parts.shift() || ""
    if (!server || !share || [".", "..", "localhost"].includes(server.toLowerCase()) || [".", ".."].includes(share)) {
      return { kind: "opaque", normalized: raw, reason: "ambiguous_windows_namespace_unc" }
    }
    return { kind: "windows_unc", normalized: `\\\\${server}\\${share}${parts.length ? `\\${parts.join("\\")}` : ""}` }
  }

  const driveMatch = raw.match(/^\\\\[?.]\\([A-Za-z]:\\.*)$/)
  if (driveMatch) return { kind: "windows_drive", normalized: driveMatch[1] }

  if (/^\\\\[?.]\\/.test(raw)) {
    return { kind: "opaque", normalized: raw, reason: "unsupported_windows_namespace" }
  }
  return null
}

function classify(raw) {
  const namespace = normalizeWindowsNamespace(raw)
  if (namespace) return namespace

  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return { kind: "windows_drive", normalized: raw.replaceAll("/", "\\") }
  }
  if (/^\\\\[^\\]+\\[^\\]+/.test(raw)) {
    const parts = raw.slice(2).split("\\")
    const server = parts.shift() || ""
    const share = parts.shift() || ""
    if ([".", "..", "localhost"].includes(server.toLowerCase()) || [".", ".."].includes(share)) {
      return { kind: "opaque", normalized: raw, reason: "ambiguous_windows_unc" }
    }
    return { kind: "windows_unc", normalized: raw }
  }
  if (raw.startsWith("/") && !raw.startsWith("//")) return { kind: "posix", normalized: raw }
  return { kind: "opaque", normalized: raw, reason: "relative_or_unknown_path" }
}

function toUri(pathInfo) {
  if (pathInfo.kind === "windows_drive") {
    const slashPath = pathInfo.normalized.replaceAll("\\", "/")
    return `file:///${encodePathSegments(slashPath)}`
  }
  if (pathInfo.kind === "windows_unc") {
    const parts = pathInfo.normalized.slice(2).split("\\")
    const server = parts.shift()
    return `file://${server}/${encodePathSegments(parts.join("/"))}`
  }
  if (pathInfo.kind === "posix") return `file://${encodePathSegments(pathInfo.normalized)}`
  return null
}

function matchesHost(kind, host) {
  if (host === "windows") return kind === "windows_drive" || kind === "windows_unc"
  return kind === "posix"
}

const findings = []
let rejected = false
for (const terminal of evidence.terminals) {
  if (!terminal || typeof terminal.item_id !== "string" || typeof terminal.cwd !== "string" || terminal.cwd.length === 0) {
    console.error("Each terminal requires non-empty item_id and cwd strings")
    process.exit(2)
  }

  const purpose = terminal.purpose || "display_only"
  if (!new Set(["display_only", "local_filesystem_authority"]).has(purpose)) {
    console.error(`Unsupported terminal purpose for ${terminal.item_id}`)
    process.exit(2)
  }

  const pathInfo = classify(terminal.cwd)
  const normalizedUri = toUri(pathInfo)
  const foreign = pathInfo.kind !== "opaque" && !matchesHost(pathInfo.kind, evidence.host_platform)
  const reasons = []

  if (terminal.expected_normalized_uri && terminal.expected_normalized_uri !== normalizedUri) {
    reasons.push("normalized_uri_mismatch")
  }

  if (purpose === "local_filesystem_authority") {
    if (pathInfo.kind === "opaque") reasons.push(pathInfo.reason || "opaque_path")
    if (foreign) reasons.push("foreign_path_cannot_grant_local_authority")
    if (terminal.local_authority_verified !== true) reasons.push("independent_local_path_verification_required")
  }

  if (reasons.length > 0) rejected = true
  findings.push({
    item_id: terminal.item_id,
    cwd: terminal.cwd,
    purpose,
    path_kind: pathInfo.kind,
    normalized_path: pathInfo.normalized,
    normalized_uri: normalizedUri,
    foreign_to_host: foreign,
    admitted: reasons.length === 0,
    reasons,
  })
}

const result = {
  admitted: !rejected,
  host_platform: evidence.host_platform,
  policy: "terminal cwd values are provenance/display data and never grant local filesystem authority without independent verification",
  findings,
}

if (jsonOutput) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`Codex terminal path provenance: ${result.admitted ? "admitted" : "rejected"}`)
  for (const finding of findings) {
    console.log(`- ${finding.item_id}: ${finding.path_kind}; ${finding.admitted ? "admitted" : finding.reasons.join(", ")}`)
  }
}
process.exit(rejected ? 64 : 0)
