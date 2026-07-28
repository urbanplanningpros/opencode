import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const MAX_INPUT_BYTES = 1_048_576
const MAX_SKILLS = 512
const MAX_WARNINGS = 128
const MAX_VALUE_CHARS = 512
const PROHIBITED_ROUTE_PATTERN = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot[-_ ]?auto|model[-_ ]?gateway)/i
const BUDGET_WARNING_PATTERN = /(skills? context budget|skills? list.*omitted|additional skills? omitted|host skills.*omitted|descriptions? (?:were )?removed)/i

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function fail(message, exitCode = 2, details = {}) {
  const result = {
    status: exitCode === 64 ? "policy_rejected" : exitCode === 75 ? "containment_required" : "invalid_input",
    safe_to_continue: false,
    safe_for_external_writes: false,
    message,
    ...details,
  }
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.error(message)
  process.exit(exitCode)
}

function readInput(inputPath) {
  const resolved = path.resolve(inputPath)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Skill catalog evidence must be a regular, non-symlinked file.")
  if (stat.size > MAX_INPUT_BYTES) fail(`Skill catalog evidence exceeds ${MAX_INPUT_BYTES} bytes.`)
  return { resolved, content: fs.readFileSync(resolved, "utf8") }
}

function normalizeList(value, field, limit) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`)
  if (value.length > limit) fail(`${field} exceeds the ${limit}-entry limit.`)
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") fail(`${field} entries must be strings.`)
    const item = entry.trim()
    if (!item || item.length > MAX_VALUE_CHARS) fail(`${field} contains an empty or oversized value.`)
    return item
  })
  if (new Set(normalized).size !== normalized.length) fail(`${field} contains duplicate values.`)
  return normalized
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) fail("Pass --input with a Codex skill catalog evidence JSON file.")

const input = readInput(args.input)
let evidence
try {
  evidence = JSON.parse(input.content)
} catch {
  fail("Skill catalog evidence is not valid JSON.")
}

if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail("Skill catalog evidence must be a JSON object.")
if (evidence.schema_version !== 1) fail("Unsupported skill catalog evidence schema_version; expected 1.")
if (evidence.runtime !== "codex") fail("Skill catalog evidence runtime must be codex.")
if (typeof evidence.write_authority_requested !== "boolean") fail("write_authority_requested must be boolean.")

const requiredSkills = normalizeList(evidence.required_skills, "required_skills", MAX_SKILLS)
const visibleHostSkills = normalizeList(evidence.visible_host_skills, "visible_host_skills", MAX_SKILLS)
const visibleExecutorSkills = normalizeList(evidence.visible_executor_skills, "visible_executor_skills", MAX_SKILLS)
const warnings = normalizeList(evidence.warnings, "warnings", MAX_WARNINGS)
const allSkillIdentifiers = [...requiredSkills, ...visibleHostSkills, ...visibleExecutorSkills]
const prohibitedIdentifiers = allSkillIdentifiers.filter((value) => PROHIBITED_ROUTE_PATTERN.test(value))

if (prohibitedIdentifiers.length > 0) {
  fail("Skill catalog evidence contains a prohibited provider, gateway, or automatic-routing identifier.", 64, {
    prohibited_identifiers: prohibitedIdentifiers,
  })
}

const visibleSkills = [...new Set([...visibleHostSkills, ...visibleExecutorSkills])]
const visibleSkillSet = new Set(visibleSkills)
const missingRequiredSkills = requiredSkills.filter((skill) => !visibleSkillSet.has(skill))
const budgetWarnings = warnings.filter((warning) => BUDGET_WARNING_PATTERN.test(warning))
const budgetPressure = budgetWarnings.length > 0
const containmentRequired = missingRequiredSkills.length > 0 || (evidence.write_authority_requested && budgetPressure)
const normalizedEvidence = {
  schema_version: 1,
  runtime: "codex",
  catalog_source: typeof evidence.catalog_source === "string" ? evidence.catalog_source.trim() : null,
  write_authority_requested: evidence.write_authority_requested,
  required_skills: requiredSkills,
  visible_host_skills: visibleHostSkills,
  visible_executor_skills: visibleExecutorSkills,
  warnings,
}

const result = {
  status: containmentRequired ? "containment_required" : "verified",
  safe_to_continue: !containmentRequired,
  safe_for_external_writes: !containmentRequired && evidence.write_authority_requested,
  read_only_continuity_allowed: missingRequiredSkills.length === 0,
  evidence_path: input.resolved,
  evidence_sha256: canonicalHash(normalizedEvidence),
  required_skill_count: requiredSkills.length,
  visible_host_skill_count: visibleHostSkills.length,
  visible_executor_skill_count: visibleExecutorSkills.length,
  visible_skill_count: visibleSkills.length,
  missing_required_skills: missingRequiredSkills,
  budget_pressure: budgetPressure,
  budget_warnings: budgetWarnings,
  action: containmentRequired
    ? "Start a fresh bounded Codex task with only the exact required approved skills, capture a new catalog, and rerun this guard before granting write authority."
    : "Continue within the declared authority boundary.",
}

if (args.json) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`Skill catalog status: ${result.status}`)
  console.log(`Required skills: ${result.required_skill_count}`)
  console.log(`Visible skills: ${result.visible_skill_count}`)
  if (result.missing_required_skills.length > 0) console.error(`Missing: ${result.missing_required_skills.join(", ")}`)
  if (result.budget_pressure) console.error("Codex reported skill catalog budget pressure.")
  console.log(result.action)
}

process.exit(containmentRequired ? 75 : 0)
