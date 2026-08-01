import fs from "node:fs"
import path from "node:path"
import { readJson, repoRoot } from "./lib.mjs"

const goalPath = path.join(repoRoot, "config/operator-goal.json")
const schemaPath = path.join(repoRoot, "schemas/operator-goal.schema.json")
const routingPath = path.join(repoRoot, "config/operator-routing.json")
const goal = readJson(goalPath)
const routing = readJson(routingPath)
const failures = []

const requiredExcludedProviders = ["anthropic", "claude", "manus"]
const requiredProhibitedRoutes = [
  "openrouter",
  "amazon-bedrock",
  "google-vertex",
  "github-copilot-auto",
  "model-gateway",
  "automatic-selector",
]
const requiredGuidedClasses = [
  "production",
  "deployment",
  "credential",
  "billing",
  "permission_expansion",
  "destructive_change",
  "customer_facing",
  "publication",
  "external_write",
  "irreversible_change",
]
const requiredStateFields = [
  "task_id",
  "thread_id",
  "operation_id",
  "idempotency_key",
  "repository_sha",
  "diff_hash",
  "external_write_state",
]
const retiringModels = new Set(["gpt-5.4", "gpt-5.4-mini"])
const automaticModelPattern = /(^|[-_.])(auto|automatic|selector|router|gateway)([-_.]|$)/i

function requireMembers(actual, expected, label) {
  const values = new Set(Array.isArray(actual) ? actual : [])
  for (const value of expected) {
    if (!values.has(value)) failures.push(`${label} is missing '${value}'`)
  }
}

if (!fs.existsSync(schemaPath)) failures.push("operator goal schema is missing")
else readJson(schemaPath)

if (goal.version !== 1) failures.push("operator goal version must be 1")
if (goal.patching?.mode !== "autonomous_with_guided_intervention") {
  failures.push("patching mode must be autonomous_with_guided_intervention")
}
if (goal.patching?.guidedInterventionDefault !== true) {
  failures.push("guided intervention must be the default safety checkpoint")
}
if (goal.patching?.validateWithCanary !== true) failures.push("patches must require bounded canary validation")
if (goal.patching?.pauseOnlyWhenNoSafeRoute !== true) {
  failures.push("the policy must pause only when no safe approved route exists")
}
if (goal.routing?.automaticModelSelection !== false) failures.push("automatic model selection must be disabled")
if (goal.routing?.gatewaysAllowed !== false) failures.push("model gateways must be disabled")

const approvedProviders = new Set(goal.routing?.approvedProviders || [])
for (const provider of approvedProviders) {
  if (!new Set(["openai", "local"]).has(provider)) failures.push(`unapproved provider '${provider}' in operator goal`)
}
requireMembers(goal.routing?.excludedProviders, requiredExcludedProviders, "excludedProviders")
requireMembers(goal.routing?.prohibitedRoutes, requiredProhibitedRoutes, "prohibitedRoutes")
requireMembers(goal.patching?.guidedInterventionRequiredFor, requiredGuidedClasses, "guidedInterventionRequiredFor")
requireMembers(goal.patching?.preserveState, requiredStateFields, "preserveState")

const replacements = goal.modelMigration?.replacements || {}
if (goal.modelMigration?.deadline !== "2026-08-31") failures.push("GPT-5.4 migration deadline must be 2026-08-31")
if (goal.modelMigration?.authenticationBoundary !== "chatgpt") {
  failures.push("GPT-5.4 retirement migration must be scoped to ChatGPT-authenticated Codex")
}
if (replacements["gpt-5.4"] !== "gpt-5.6-terra") failures.push("gpt-5.4 must migrate to gpt-5.6-terra")
if (replacements["gpt-5.4-mini"] !== "gpt-5.6-luna") failures.push("gpt-5.4-mini must migrate to gpt-5.6-luna")
if (goal.modelMigration?.verifyEffectiveModel !== true) failures.push("effective model verification must be required")
if (goal.modelMigration?.apiKeyCompatibilityRequiresGuidedIntervention !== true) {
  failures.push("API-key legacy compatibility must require guided intervention")
}

for (const [provider, definition] of Object.entries(routing.providers || {})) {
  if (!approvedProviders.has(provider)) failures.push(`routing provider '${provider}' is not approved by operator goal`)
  const routes = [definition.models?.primary, ...(definition.models?.fallbacks || []), definition.models?.candidate].filter(Boolean)
  for (const route of routes) {
    const model = route.id || ""
    if (retiringModels.has(model)) failures.push(`routing provider '${provider}' still references retiring model '${model}'`)
    if (provider === "openai" && automaticModelPattern.test(model)) {
      failures.push(`OpenAI route '${model}' appears to use automatic model selection`)
    }
  }
}

if (failures.length > 0) {
  console.error("Operator goal is invalid:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Operator goal valid: ${goal.patching.mode}; guided intervention default; ${Object.keys(replacements).length} model migrations enforced`,
)
