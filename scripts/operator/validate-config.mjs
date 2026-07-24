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

console.log(`Operator configuration valid: ${Object.keys(config.providers).length} providers, ${Object.keys(config.profiles).length} profiles`)
