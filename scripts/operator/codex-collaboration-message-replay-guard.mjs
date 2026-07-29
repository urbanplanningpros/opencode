import fs from "node:fs"
import path from "node:path"

const COLLABORATION_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"])
const PROHIBITED_ROUTE_PATTERN = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway)/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) parsed[key] = true
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function readEvidence(args) {
  const text = args.input ? fs.readFileSync(path.resolve(args.input), "utf8") : fs.readFileSync(0, "utf8")
  if (!text.trim()) throw new Error("a JSON collaboration evidence record is required")
  return JSON.parse(text)
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, output)
  return output
}

function requireSha(value, field, failures) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) failures.push(`${field} must be a SHA-256 hex digest`)
}

function markerMode(record, field, failures) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    failures.push(`${field} must be an object`)
    return "invalid"
  }
  if (typeof record.field_present !== "boolean") failures.push(`${field}.field_present must be boolean`)
  if (!Number.isInteger(record.item_count) || record.item_count < 0) failures.push(`${field}.item_count must be a non-negative integer`)
  if (record.field_present === false && record.item_count !== 0) failures.push(`${field}.item_count must be zero when the field is absent`)
  if (record.field_present === false) return "absent_encrypted"
  if (record.item_count === 0) return "plaintext_structured"
  return "encrypted"
}

function validateEvidence(evidence) {
  const failures = []
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { failures: ["collaboration evidence must be an object"] }
  }

  if (evidence.route !== "direct_openai") failures.push("route must be 'direct_openai'")
  if (!COLLABORATION_TOOLS.has(evidence.tool)) failures.push("tool must be spawn_agent, send_message, or followup_task")
  requireSha(evidence.arguments_sha256, "arguments_sha256", failures)

  const originalMode = markerMode(evidence.original_marker, "original_marker", failures)
  const replayMode = markerMode(evidence.replay_marker, "replay_marker", failures)
  if (originalMode !== replayMode) failures.push("replay must preserve encrypted_function_args field presence and empty/non-empty semantics")

  const lineage = evidence.lineage
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) {
    failures.push("lineage must be an object")
  } else {
    if (typeof lineage.turn_id !== "string" || lineage.turn_id.trim() === "") failures.push("lineage.turn_id is required")
    if (typeof lineage.parent_turn_id !== "string" || lineage.parent_turn_id.trim() === "") failures.push("lineage.parent_turn_id is required")
    if (lineage.parent_turn_id !== lineage.expected_parent_turn_id) failures.push("lineage.parent_turn_id does not match expected_parent_turn_id")
    if (typeof lineage.root_turn_id !== "string" || lineage.root_turn_id.trim() === "") failures.push("lineage.root_turn_id is required")
    if (lineage.authorized !== true) failures.push("lineage.authorized must be true")
  }

  const logging = evidence.logging
  if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
    failures.push("logging must be an object")
  } else {
    if (logging.tool_arguments_redacted !== true) failures.push("logging.tool_arguments_redacted must be true")
    if (logging.communication_payload_redacted !== true) failures.push("logging.communication_payload_redacted must be true")
    if (logging.raw_arguments_persisted !== false) failures.push("logging.raw_arguments_persisted must be false")
  }

  if (originalMode === "plaintext_structured") {
    if (evidence.delivery !== "structured_plaintext_agent_message") {
      failures.push("empty encrypted_function_args requires structured_plaintext_agent_message delivery")
    }
  } else if (originalMode === "encrypted" || originalMode === "absent_encrypted") {
    if (evidence.delivery !== "encrypted_agent_message") failures.push("non-empty or absent marker requires encrypted_agent_message delivery")
  }

  if (evidence.downstream?.non_openai_metadata_forwarded !== false) {
    failures.push("provider-specific encrypted_function_args metadata must not be forwarded outside the direct OpenAI route")
  }

  const prohibited = collectStrings(evidence).filter((value) => PROHIBITED_ROUTE_PATTERN.test(value))
  if (prohibited.length > 0) failures.push("evidence contains an excluded provider, gateway, or automatic-selection identifier")

  return {
    failures,
    normalized: {
      tool: evidence.tool ?? null,
      route: evidence.route ?? null,
      marker_mode: originalMode,
      replay_marker_mode: replayMode,
      delivery: evidence.delivery ?? null,
      parent_turn_id: lineage?.parent_turn_id ?? null,
      expected_parent_turn_id: lineage?.expected_parent_turn_id ?? null,
      logs_redacted: logging?.tool_arguments_redacted === true && logging?.communication_payload_redacted === true,
    },
  }
}

const args = parseArgs(process.argv.slice(2))
let evidence
try {
  evidence = readEvidence(args)
} catch (error) {
  const report = { allowed: false, input_error: error.message }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.error(`Collaboration message guard input error: ${error.message}`)
  process.exit(2)
}

const { failures, normalized } = validateEvidence(evidence)
const report = {
  allowed: failures.length === 0,
  failures,
  normalized,
  policy: {
    empty_encrypted_function_args: "semantic plaintext marker; preserve across replay",
    logging: "redact collaboration arguments from tool and communication logs",
    authority: "parent-turn lineage and task authority remain mandatory",
  },
}

if (args.json) console.log(JSON.stringify(report, null, 2))
else if (report.allowed) console.log("Codex collaboration message replay allowed")
else {
  console.error("Codex collaboration message replay rejected:")
  for (const failure of failures) console.error(`- ${failure}`)
}

process.exit(report.allowed ? 0 : 64)
