import fs from "node:fs"

const STEP_CONTEXT_FIX_COMMIT = "250de82bfb51a210325e88bfe1f7c30b0fa514f0"
const PROHIBITED_ROUTE_PATTERN = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway)/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

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
  const text = args.input ? fs.readFileSync(args.input, "utf8") : fs.readFileSync(0, "utf8")
  if (!text.trim()) throw new Error("a JSON MCP file-upload receipt is required")
  return JSON.parse(text)
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, output)
  return output
}

function requireString(value, field, failures) {
  if (typeof value !== "string" || value.trim() === "") failures.push(`${field} must be a non-empty string`)
}

function requireSha(value, field, failures) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) failures.push(`${field} must be a SHA-256 hex digest`)
}

function validateReceipt(receipt) {
  const policyFailures = []
  const compatibilityFailures = []

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { policyFailures: ["receipt must be a JSON object"], compatibilityFailures }
  }

  if (!new Set(["production", "canary"]).has(receipt.admission)) {
    policyFailures.push("admission must be 'production' or 'canary'")
  }

  const runtime = receipt.runtime
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    policyFailures.push("runtime must be an object")
  } else {
    requireString(runtime.version, "runtime.version", policyFailures)
    if (runtime.fixed_step_context === true) {
      if (runtime.fix_reference !== STEP_CONTEXT_FIX_COMMIT) {
        policyFailures.push(`runtime.fix_reference must identify upstream step-context fix ${STEP_CONTEXT_FIX_COMMIT}`)
      }
      if (receipt.admission === "production" && runtime.production_fix_validated !== true) {
        compatibilityFailures.push("a runtime containing the step-context fix is canary-only until its stable release and production validation are recorded")
      }
    }
  }

  const route = receipt.route
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    policyFailures.push("route must be an object")
  } else {
    if (route.provider !== "openai") policyFailures.push("route.provider must be the explicitly pinned direct OpenAI route")
    if (route.transport !== "direct") policyFailures.push("route.transport must be 'direct'")
    if (route.auth_mode !== "chatgpt") policyFailures.push("route.auth_mode must be 'chatgpt' for Codex Apps file uploads")
  }

  requireString(receipt.operation_id, "operation_id", policyFailures)
  requireString(receipt.idempotency_key, "idempotency_key", policyFailures)

  const task = receipt.task
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    policyFailures.push("task must be an object")
  } else {
    if (!new Set(["read", "write"]).has(task.mode)) policyFailures.push("task.mode must be 'read' or 'write'")
    requireString(task.tool, "task.tool", policyFailures)
    requireSha(task.arguments_sha256, "task.arguments_sha256", policyFailures)

    if (task.mode === "write") {
      const verification = task.verification
      if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
        policyFailures.push("write tasks require an independent verification plan")
      } else {
        requireString(verification.tool, "task.verification.tool", policyFailures)
        requireSha(verification.expected_sha256, "task.verification.expected_sha256", policyFailures)
        if (verification.tool === task.tool) policyFailures.push("task.verification.tool must differ from the write tool")
        if (verification.destination_read_required !== true) {
          policyFailures.push("task.verification.destination_read_required must be true")
        }
      }
    }
  }

  const environment = receipt.environment
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    policyFailures.push("environment must be an object")
  } else {
    requireString(environment.expected_id, "environment.expected_id", policyFailures)
    requireString(environment.step_primary_id, "environment.step_primary_id", policyFailures)
    requireSha(environment.capability_roots_sha256, "environment.capability_roots_sha256", policyFailures)

    if (!new Set(["starting", "ready"]).has(environment.turn_state)) {
      policyFailures.push("environment.turn_state must be 'starting' or 'ready'")
    }
    if (environment.step_state !== "ready") {
      compatibilityFailures.push("the selected environment must be ready in the current step before file argument rewriting")
    }
    if (environment.step_primary_id !== environment.expected_id) {
      compatibilityFailures.push("the current step primary environment does not match the approved environment")
    }
    if (environment.step_context_refreshed !== true) {
      compatibilityFailures.push("the MCP file upload requires a refreshed step-context environment snapshot")
    }

    if (environment.became_ready_during_turn === true) {
      if (runtime?.fixed_step_context !== true) {
        compatibilityFailures.push("this runtime can use the stale turn snapshot when an environment becomes ready during the turn")
      }
    } else if (environment.became_ready_during_turn === false) {
      if (environment.turn_state !== "ready" || environment.turn_primary_id !== environment.expected_id) {
        policyFailures.push("an environment declared ready before the turn must match the approved turn primary environment")
      }
    } else {
      policyFailures.push("environment.became_ready_during_turn must be boolean")
    }
  }

  const files = receipt.files
  if (!Array.isArray(files) || files.length === 0) {
    policyFailures.push("files must contain at least one declared MCP file argument")
  } else {
    const fields = new Set()
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const prefix = `files[${index}]`
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        policyFailures.push(`${prefix} must be an object`)
        continue
      }
      requireString(file.field, `${prefix}.field`, policyFailures)
      requireString(file.path_uri, `${prefix}.path_uri`, policyFailures)
      requireString(file.approved_root_id, `${prefix}.approved_root_id`, policyFailures)
      requireSha(file.approved_root_sha256, `${prefix}.approved_root_sha256`, policyFailures)
      requireSha(file.content_sha256, `${prefix}.content_sha256`, policyFailures)
      if (file.regular_file !== true) policyFailures.push(`${prefix}.regular_file must be true`)
      if (file.symlink !== false) policyFailures.push(`${prefix}.symlink must be false`)
      if (file.resolved_environment_id !== environment?.expected_id) {
        policyFailures.push(`${prefix}.resolved_environment_id must match environment.expected_id`)
      }
      if (fields.has(file.field)) policyFailures.push(`files repeats declared field '${file.field}'`)
      fields.add(file.field)
    }
  }

  if (collectStrings(receipt).some((value) => PROHIBITED_ROUTE_PATTERN.test(value))) {
    policyFailures.push("receipt contains an excluded provider, model gateway, or automatic-selection identifier")
  }

  return { policyFailures, compatibilityFailures }
}

const args = parseArgs(process.argv.slice(2))
let receipt
try {
  receipt = readInput(args)
} catch (error) {
  const report = { allowed: false, input_error: error.message }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.error(`MCP file-upload guard input error: ${error.message}`)
  process.exit(2)
}

const { policyFailures, compatibilityFailures } = validateReceipt(receipt)
const exitCode = policyFailures.length > 0 ? 64 : compatibilityFailures.length > 0 ? 75 : 0
const report = {
  allowed: exitCode === 0,
  policy_failures: policyFailures,
  compatibility_failures: compatibilityFailures,
  normalized: {
    admission: receipt.admission ?? null,
    runtime_version: receipt.runtime?.version ?? null,
    fixed_step_context: receipt.runtime?.fixed_step_context === true,
    operation_id: receipt.operation_id ?? null,
    task_mode: receipt.task?.mode ?? null,
    file_count: Array.isArray(receipt.files) ? receipt.files.length : 0,
    environment_id: receipt.environment?.expected_id ?? null,
    became_ready_during_turn: receipt.environment?.became_ready_during_turn ?? null,
  },
  continuity: {
    automatic_replay: false,
    approved_fallbacks: [
      "wait for the approved environment to become ready, then start a fresh guarded turn with the same operation and idempotency identifiers",
      "dispatch the file operation through an explicitly authorized local connector executor and independently verify the destination",
    ],
  },
  upstream_fix_reference: STEP_CONTEXT_FIX_COMMIT,
}

if (args.json) console.log(JSON.stringify(report, null, 2))
else if (report.allowed) console.log("MCP file-upload environment receipt allowed")
else {
  console.error("MCP file-upload environment receipt rejected:")
  for (const failure of [...policyFailures, ...compatibilityFailures]) console.error(`- ${failure}`)
}

process.exit(exitCode)
