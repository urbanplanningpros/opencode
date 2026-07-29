import fs from "node:fs"
import path from "node:path"

const PROHIBITED_ROUTE_PATTERN = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway)/i
const TRUE_VALUES = new Set(["1", "true", "yes", "on"])
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""])

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

function readPlan(args) {
  const input = args.input ? fs.readFileSync(path.resolve(args.input), "utf8") : fs.readFileSync(0, "utf8")
  if (!input.trim()) throw new Error("a JSON lifecycle plan is required")
  return JSON.parse(input)
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output)
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, output)
  return output
}

function hasExitFlag(command) {
  return command.includes("--exit-on-stdin-close")
}

function parseLifetimeEnv(value, failures) {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  failures.push("CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE must be a recognized boolean value")
  return null
}

function validatePlan(plan) {
  const failures = []
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { failures: ["lifecycle plan must be an object"] }

  const mode = plan.mode
  if (!new Set(["parent_owned", "standalone"]).has(mode)) failures.push("mode must be 'parent_owned' or 'standalone'")

  const command = Array.isArray(plan.command) ? plan.command : []
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
    failures.push("command must be a non-empty string array")
  } else {
    if (!path.isAbsolute(command[0])) failures.push("command[0] must be an absolute executable path")
    if (!command.includes("exec-server")) failures.push("command must invoke the Codex exec-server subcommand")
    if (!command.includes("--remote")) failures.push("parent-lifetime policy is scoped to remote exec servers")
  }

  const env = plan.env && typeof plan.env === "object" && !Array.isArray(plan.env) ? plan.env : {}
  const envLifetime = parseLifetimeEnv(env.CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE, failures)
  const flagLifetime = hasExitFlag(command)
  const lifetimeEnabled = envLifetime === true || flagLifetime
  const lifetimeExplicitlyDisabled = envLifetime === false && !flagLifetime

  if (plan.transport !== "stdio") failures.push("transport must be 'stdio' so parent ownership is observable")
  if (plan.route !== "direct_openai" && plan.route !== "authorized_local") {
    failures.push("route must be 'direct_openai' or 'authorized_local'")
  }

  if (mode === "parent_owned") {
    if (plan.stdin !== "pipe") failures.push("parent_owned mode requires stdin='pipe'")
    if (plan.detached !== false) failures.push("parent_owned mode requires detached=false")
    if (!lifetimeEnabled) failures.push("parent_owned mode requires --exit-on-stdin-close or CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE=1")
    if (plan.shutdown?.graceful_drain !== true) failures.push("parent_owned mode requires shutdown.graceful_drain=true")
    if (plan.shutdown?.terminate_owned_children !== true) failures.push("parent_owned mode requires shutdown.terminate_owned_children=true")
    if (plan.shutdown?.flush_telemetry !== true) failures.push("parent_owned mode requires shutdown.flush_telemetry=true")
    if (plan.child_environment?.inherits_parent_lifetime_control !== false) {
      failures.push("child_environment.inherits_parent_lifetime_control must be false")
    }
  }

  if (mode === "standalone") {
    if (flagLifetime || envLifetime === true) failures.push("standalone mode must not enable exit-on-stdin-close")
    if (!lifetimeExplicitlyDisabled && env.CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE !== undefined) {
      failures.push("standalone lifetime environment value is ambiguous")
    }
    if (plan.detached !== true) failures.push("standalone mode requires detached=true and explicit service supervision")
    const supervision = plan.supervision
    if (!supervision || typeof supervision !== "object" || Array.isArray(supervision)) {
      failures.push("standalone mode requires a supervision object")
    } else {
      if (typeof supervision.pid_file !== "string" || !path.isAbsolute(supervision.pid_file)) {
        failures.push("standalone supervision.pid_file must be an absolute path")
      }
      if (typeof supervision.healthcheck !== "string" || supervision.healthcheck.trim() === "") {
        failures.push("standalone supervision.healthcheck is required")
      }
      if (!Number.isInteger(supervision.shutdown_timeout_seconds) || supervision.shutdown_timeout_seconds < 1) {
        failures.push("standalone supervision.shutdown_timeout_seconds must be a positive integer")
      }
    }
  }

  const prohibited = collectStrings(plan).filter((value) => PROHIBITED_ROUTE_PATTERN.test(value))
  if (prohibited.length > 0) failures.push("lifecycle plan contains an excluded provider, gateway, or automatic-selection identifier")

  return {
    failures,
    normalized: {
      mode,
      route: plan.route ?? null,
      transport: plan.transport ?? null,
      stdin: plan.stdin ?? null,
      detached: plan.detached ?? null,
      exit_on_stdin_close: lifetimeEnabled,
      command: command.length > 0 ? command[0] : null,
      child_lifetime_control_removed: plan.child_environment?.inherits_parent_lifetime_control === false,
    },
  }
}

const args = parseArgs(process.argv.slice(2))
let plan
try {
  plan = readPlan(args)
} catch (error) {
  const report = { allowed: false, input_error: error.message }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.error(`Exec-server lifecycle guard input error: ${error.message}`)
  process.exit(2)
}

const { failures, normalized } = validatePlan(plan)
const report = {
  allowed: failures.length === 0,
  failures,
  normalized,
  policy: {
    parent_owned: "stdin pipe is the lifetime authority",
    standalone: "explicit service supervision is the lifetime authority",
    automatic_reroute: false,
  },
}

if (args.json) console.log(JSON.stringify(report, null, 2))
else if (report.allowed) console.log("Codex exec-server lifecycle plan allowed")
else {
  console.error("Codex exec-server lifecycle plan rejected:")
  for (const failure of failures) console.error(`- ${failure}`)
}

process.exit(report.allowed ? 0 : 64)
