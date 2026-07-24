import fs from "node:fs"
import path from "node:path"
import { readJson, repoRoot } from "./lib.mjs"

const configPath = path.join(repoRoot, "config/operator-routing.json")
const schemaPaths = [
  path.join(repoRoot, "schemas/operator-routing.schema.json"),
  path.join(repoRoot, "schemas/operator-task.schema.json"),
]

const config = readJson(configPath)
const failures = []

if (!Number.isInteger(config.version) || config.version < 1) failures.push("version must be a positive integer")
if (!config.providers || Object.keys(config.providers).length === 0) failures.push("at least one provider is required")
if (!config.profiles?.[config.defaultProfile]) failures.push(`default profile '${config.defaultProfile}' is missing`)

for (const [provider, definition] of Object.entries(config.providers || {})) {
  if (!definition.commandEnv || typeof definition.commandEnv !== "string") {
    failures.push(`provider '${provider}' is missing commandEnv`)
  }
  if (/manus/i.test(provider) || /manus/i.test(definition.commandEnv || "")) {
    failures.push(`provider '${provider}' violates the Manus exclusion policy`)
  }
  if (!definition.models?.primary?.id) failures.push(`provider '${provider}' is missing a primary model`)
  if (!Array.isArray(definition.models?.fallbacks)) failures.push(`provider '${provider}' fallbacks must be an array`)

  const routes = [
    definition.models?.primary,
    ...(definition.models?.fallbacks || []),
    definition.models?.candidate,
  ].filter(Boolean)
  const modelIds = new Set()
  for (const route of routes) {
    if (!route.id || typeof route.id !== "string") failures.push(`provider '${provider}' has a model without an id`)
    if (/manus/i.test(route.id || "")) failures.push(`provider '${provider}' model '${route.id}' violates the Manus exclusion policy`)
    if (modelIds.has(route.id)) failures.push(`provider '${provider}' repeats model '${route.id}'`)
    modelIds.add(route.id)
    if (!route.requestPolicy || typeof route.requestPolicy !== "object" || Array.isArray(route.requestPolicy)) {
      failures.push(`provider '${provider}' model '${route.id}' requires requestPolicy`)
    }
  }

  const candidate = definition.models?.candidate
  if (candidate) {
    if (!Number.isInteger(candidate.percent) || candidate.percent < 0 || candidate.percent > 100) {
      failures.push(`provider '${provider}' candidate percent must be an integer from 0 to 100`)
    }
    if (typeof candidate.readOnly !== "boolean") {
      failures.push(`provider '${provider}' candidate readOnly must be boolean`)
    }
  }

  const opus5 = routes.find((route) => route.id === "claude-opus-5")
  if (opus5) {
    if (candidate?.id !== "claude-opus-5" || candidate.readOnly !== true) {
      failures.push("claude-opus-5 must remain a read-only candidate until promotion criteria are met")
    }
    if (opus5.requestPolicy.thinking !== "adaptive_default") {
      failures.push("claude-opus-5 must use adaptive_default thinking")
    }
    if (opus5.requestPolicy.disableThinkingMaxEffort !== "high") {
      failures.push("claude-opus-5 must cap disabled-thinking requests at high effort")
    }
    if (opus5.requestPolicy.serverSideFallback !== "disabled") {
      failures.push("claude-opus-5 server-side fallback must remain disabled for auditable routing")
    }
    if (opus5.requestPolicy.midConversationToolChanges !== "disabled") {
      failures.push("claude-opus-5 mid-conversation tool changes must remain disabled during canary")
    }
  }
}

for (const [profile, definition] of Object.entries(config.profiles || {})) {
  if (!Array.isArray(definition.order) || definition.order.length === 0) {
    failures.push(`profile '${profile}' requires an ordered provider list`)
    continue
  }
  for (const provider of definition.order) {
    if (!config.providers[provider]) failures.push(`profile '${profile}' references unknown provider '${provider}'`)
  }
  if (definition.canary && !config.providers[definition.canary.provider]) {
    failures.push(`profile '${profile}' canary references unknown provider '${definition.canary.provider}'`)
  }
}

for (const file of schemaPaths) {
  if (!fs.existsSync(file)) failures.push(`missing schema: ${path.relative(repoRoot, file)}`)
  else readJson(file)
}

if (failures.length > 0) {
  console.error("Operator configuration is invalid:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

const modelCount = Object.values(config.providers).reduce(
  (total, provider) => total + 1 + provider.models.fallbacks.length + (provider.models.candidate ? 1 : 0),
  0,
)
console.log(
  `Operator configuration valid: ${Object.keys(config.providers).length} providers, ${modelCount} models, ${Object.keys(config.profiles).length} profiles`,
)
