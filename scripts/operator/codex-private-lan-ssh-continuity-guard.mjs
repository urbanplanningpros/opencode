#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { nowIso, parseArgs, sha256, stateRoot, writeJsonAtomic } from "./lib.mjs"

const SAFE_TOKEN = /^[A-Za-z0-9_./:=+@%,-]+$/
const APPROVED_PROVIDERS = new Set(["openai", "authorized-local"])

function integer(raw, name, fallback, minimum = 1, maximum = 65535) {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function classifyIpv4(host) {
  const parts = String(host).split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null
  const octets = parts.map(Number)
  const [a, b] = octets
  if (a === 10) return "rfc1918"
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918"
  if (a === 192 && b === 168) return "rfc1918"
  if (a === 127) return "loopback"
  if (a === 169 && b === 254) return "link-local"
  return "public"
}

export function validateHost(host) {
  if (!host || typeof host !== "string") throw new Error("A destination host is required")
  if (!SAFE_TOKEN.test(host) || host.includes("/") || host.includes("@") || host.includes(":")) {
    throw new Error("Destination host contains unsafe or unsupported characters")
  }
  const ipClass = classifyIpv4(host)
  if (ipClass === "rfc1918") return { host, classification: ipClass }
  if (ipClass) throw new Error(`Destination ${host} is ${ipClass}; this guard permits RFC1918 private-LAN targets only`)
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*\.(local|lan)$/i.test(host)) return { host, classification: "private-name" }
  throw new Error("Destination must be an RFC1918 IPv4 address or an explicit .local/.lan hostname")
}

export function validateRemoteCommand(command) {
  if (!Array.isArray(command) || command.length === 0) throw new Error("remote command must be a non-empty JSON string array")
  if (command.length > 64) throw new Error("remote command exceeds 64 arguments")
  for (const token of command) {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096 || !SAFE_TOKEN.test(token)) {
      throw new Error(`Unsafe remote command token: ${JSON.stringify(token)}`)
    }
  }
  return [...command]
}

function parseJsonArray(raw, name) {
  if (!raw) throw new Error(`${name} is required`)
  let value
  try { value = JSON.parse(raw) } catch { throw new Error(`${name} must be valid JSON`) }
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array`)
  return value
}

function assertAbsoluteRegularFile(file, name) {
  if (!file || !path.isAbsolute(file)) throw new Error(`${name} must be an absolute path`)
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} must be a regular non-symlink file`)
  return path.resolve(file)
}

export function buildPlan(options) {
  const operationId = String(options.operationId || "").trim()
  if (!operationId || !SAFE_TOKEN.test(operationId)) throw new Error("operation-id is required and must be a safe token")
  const provider = options.provider || "openai"
  if (!APPROVED_PROVIDERS.has(provider)) throw new Error(`Provider ${provider} is not approved`)
  if (options.automaticModelSelection === true || options.automaticModelSelection === "true") {
    throw new Error("Automatic model selection is prohibited")
  }
  if (options.gateway) throw new Error("Model gateways are prohibited")
  if (Array.isArray(options.fallbackChain) && options.fallbackChain.length > 0) throw new Error("Fallback chains are prohibited")

  const destination = validateHost(options.host)
  const port = integer(options.port, "port", 22)
  const user = String(options.user || "").trim()
  if (!user || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(user)) throw new Error("A safe SSH user is required")
  const knownHosts = path.resolve(String(options.knownHosts || ""))
  if (!options.knownHosts || !path.isAbsolute(options.knownHosts)) throw new Error("known-hosts must be an absolute path")
  const command = validateRemoteCommand(options.command)
  const identityLabel = options.identityLabel ? String(options.identityLabel) : null
  if (identityLabel && !SAFE_TOKEN.test(identityLabel)) throw new Error("identity-label must be a safe non-secret label")

  const sshArgs = [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-p", String(port),
    `${user}@${destination.host}`,
    "--",
    ...command,
  ]
  const immutable = {
    operation_id: operationId,
    route: "authorized-local-executor",
    execute_inside_codex_remote: false,
    model_route: {
      provider,
      automatic_model_selection: false,
      gateway: null,
      fallback_chain: [],
    },
    destination: { ...destination, port, user, identity_label: identityLabel },
    known_hosts_file: knownHosts,
    binary: options.binary || "ssh",
    args: sshArgs,
    remote_command: command,
  }
  return {
    schema_version: 1,
    created_at: nowIso(),
    status: "planned",
    ...immutable,
    plan_sha256: sha256(JSON.stringify(immutable)),
  }
}

export function environmentPermitsExecution(environment = process.env) {
  const authorized = environment.OPERATOR_AUTHORIZED_LOCAL_EXECUTOR === "1"
  const remoteMarkers = [
    environment.CODEX_REMOTE,
    environment.CODEX_APP_REMOTE,
    environment.OPERATOR_RUNTIME,
  ].filter(Boolean).map((value) => String(value).toLowerCase())
  const insideRemote = remoteMarkers.some((value) => ["1", "true", "codex-remote", "remote"].includes(value))
  return { authorized, inside_remote: insideRemote, permitted: authorized && !insideRemote }
}

function receiptFileFor(plan, args) {
  const root = path.resolve(args["receipt-dir"] || path.join(stateRoot(args), "private-lan-ssh"))
  return path.join(root, `${plan.created_at.replace(/[:.]/g, "-")}-${plan.operation_id}.json`)
}

function writeOutputFile(baseFile, suffix, value) {
  const file = `${baseFile}.${suffix}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, { mode: 0o600 })
  return { file, bytes: Buffer.byteLength(value), sha256: sha256(value) }
}

export function verifyReceipt(receipt, expectedOperationId) {
  if (!receipt || receipt.schema_version !== 1) throw new Error("Unsupported receipt schema")
  if (expectedOperationId && receipt.operation_id !== expectedOperationId) throw new Error("Receipt operation ID mismatch")
  if (receipt.route !== "authorized-local-executor") throw new Error("Receipt route mismatch")
  if (receipt.model_route?.provider !== "openai" && receipt.model_route?.provider !== "authorized-local") {
    throw new Error("Receipt provider is not approved")
  }
  if (receipt.model_route?.automatic_model_selection !== false || receipt.model_route?.gateway !== null) {
    throw new Error("Receipt contains an unapproved model route")
  }
  if (!Array.isArray(receipt.model_route?.fallback_chain) || receipt.model_route.fallback_chain.length !== 0) {
    throw new Error("Receipt contains an unapproved fallback chain")
  }
  if (receipt.status !== "completed" || receipt.result?.exit_code !== 0) throw new Error("SSH operation did not complete successfully")
  return true
}

async function main(argv) {
  const [subcommand, ...rest] = argv
  const args = parseArgs(rest)
  if (!new Set(["plan", "verify-receipt"]).has(subcommand)) {
    throw new Error("Usage: codex-private-lan-ssh-continuity-guard.mjs <plan|verify-receipt> [options]")
  }

  if (subcommand === "verify-receipt") {
    const receiptPath = path.resolve(String(args.receipt || ""))
    if (!args.receipt) throw new Error("--receipt is required")
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    verifyReceipt(receipt, args["operation-id"])
    console.log(JSON.stringify({ status: "verified", receipt: receiptPath, operation_id: receipt.operation_id }))
    return 0
  }

  const plan = buildPlan({
    operationId: args["operation-id"],
    provider: args.provider || "openai",
    automaticModelSelection: args["automatic-model-selection"],
    gateway: args.gateway,
    fallbackChain: args["fallback-chain"] ? parseJsonArray(args["fallback-chain"], "fallback-chain") : [],
    host: args.host,
    port: args.port,
    user: args.user,
    knownHosts: args["known-hosts"],
    identityLabel: args["identity-label"],
    binary: args.binary,
    command: parseJsonArray(args["command-json"], "command-json"),
  })
  const receiptFile = receiptFileFor(plan, args)
  writeJsonAtomic(receiptFile, plan)

  if (!args.execute) {
    console.log(JSON.stringify({ ...plan, receipt_file: receiptFile }))
    return 0
  }

  const environment = environmentPermitsExecution()
  if (!environment.permitted) {
    throw new Error("Execution is allowed only from an explicitly authorized local executor outside Codex Remote")
  }
  const knownHosts = assertAbsoluteRegularFile(plan.known_hosts_file, "known-hosts")
  const identityFile = assertAbsoluteRegularFile(process.env.OPERATOR_SSH_IDENTITY_FILE, "OPERATOR_SSH_IDENTITY_FILE")
  const finalArgs = ["-i", identityFile, ...plan.args]
  const startedAt = nowIso()
  const result = spawnSync(plan.binary, finalArgs, {
    encoding: "utf8",
    shell: false,
    timeout: integer(args["timeout-ms"], "timeout-ms", 120000, 1000, 3600000),
    env: { ...process.env },
  })
  const stdout = writeOutputFile(receiptFile, "stdout", result.stdout || "")
  const stderr = writeOutputFile(receiptFile, "stderr", result.stderr || "")
  const completed = {
    ...plan,
    status: result.status === 0 ? "completed" : "failed",
    started_at: startedAt,
    completed_at: nowIso(),
    known_hosts_file: knownHosts,
    result: {
      exit_code: result.status,
      signal: result.signal || null,
      error: result.error?.message || null,
      stdout,
      stderr,
    },
  }
  writeJsonAtomic(receiptFile, completed)
  console.log(JSON.stringify({ status: completed.status, receipt_file: receiptFile, operation_id: plan.operation_id }))
  return result.status === 0 ? 0 : 2
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
