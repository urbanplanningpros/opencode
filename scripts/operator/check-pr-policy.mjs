import { execFileSync } from "node:child_process"

const baseRef = process.env.BASE_REF
if (!baseRef) {
  console.error("BASE_REF is required")
  process.exit(2)
}

const labels = JSON.parse(process.env.PR_LABELS || "[]")
const headRef = process.env.HEAD_REF || ""
const body = process.env.PR_BODY || ""
const changed = execFileSync("git", ["diff", "--name-only", `origin/${baseRef}...HEAD`], { encoding: "utf8" })
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean)

const criticalPatterns = [
  /^AGENTS\.md$/,
  /^\.cursorrules$/,
  /^\.github\/workflows\//,
  /^\.git\/hooks\//,
  /^\.devcontainer\//,
  /^\.vscode\//,
  /(^|\/)package\.json$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)requirements.*\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)\.env[^/]*$/,
  /secret/i,
  /credential/i,
]
const critical = changed.filter((file) => criticalPatterns.some((pattern) => pattern.test(file)))
const hasCriticalApproval = labels.includes("operator-approved-critical")
const bootstrapApproved =
  headRef.startsWith("ops/ai-operator-continuity-") && /Bootstrap-Continuity-Patch:\s*owner-approved/i.test(body)
const agentGenerated = headRef.startsWith("agent/") || labels.includes("agent-generated")
const hasManifestEvidence = /Sanitized-Manifest:/i.test(body) && /Allowed-Paths:/i.test(body)
const failures = []

if (critical.length > 0 && !hasCriticalApproval && !bootstrapApproved) {
  failures.push(`Critical paths changed without operator-approved-critical label:\n${critical.map((file) => `  - ${file}`).join("\n")}`)
}
if (agentGenerated && !hasManifestEvidence) {
  failures.push("Agent-generated PRs must include 'Sanitized-Manifest:' and 'Allowed-Paths:' evidence in the PR body")
}
if (changed.some((file) => file.startsWith(".operator-state/"))) {
  failures.push("Runtime operator state must never be committed")
}

if (failures.length > 0) {
  console.error("Operator policy gate failed:\n")
  console.error(failures.join("\n\n"))
  process.exit(1)
}

console.log(`Operator policy passed for ${changed.length} changed files`)
