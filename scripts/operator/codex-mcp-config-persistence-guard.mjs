import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (!value.startsWith("--")) {
      args._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      i += 1
    }
  }
  return args
}

function emit(value, code = 0) {
  const target = code === 0 ? console.log : console.error
  target(JSON.stringify(value, null, 2))
  process.exit(code)
}

function fail(message, code = 78, details = {}) {
  emit({ status: "blocked", message, ...details }, code)
}

function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, content, { mode })
  fs.renameSync(temp, file)
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function readJsonArg(value, label, fallback) {
  if (value === undefined) return fallback
  try {
    return JSON.parse(String(value))
  } catch {
    fail(`${label} must be valid JSON`, 2)
  }
}

function validateRoute(args) {
  const provider = String(args.provider || "openai")
  const model = String(args.model || "gpt-5.6-sol")
  const route = String(args.route || "authorized-local")
  const gateway = String(args.gateway || "none")
  const fallbacks = String(args.fallbacks || "none")

  if (provider !== "openai") fail("Only the explicitly pinned OpenAI provider is authorized")
  if (!model.startsWith("gpt-") || model.toLowerCase() === "auto") {
    fail("An explicit approved OpenAI model must be pinned")
  }
  if (!new Set(["authorized-local", "direct-openai"]).has(route)) {
    fail("Route must be authorized-local or direct-openai")
  }
  if (!new Set(["", "none", "null"]).has(gateway)) fail("Model gateways are prohibited")
  if (!new Set(["", "none", "null", "[]"]).has(fallbacks)) fail("Automatic fallback chains are prohibited")

  return {
    provider,
    model,
    route,
    automatic_model_selection: false,
    gateway: null,
    fallback_chain: [],
  }
}

function parseSectionName(line) {
  const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
  return match ? match[1].trim() : null
}

function mcpServerFromSection(section) {
  if (!section || !section.startsWith("mcp_servers.")) return null
  const rest = section.slice("mcp_servers.".length)
  const quoted = rest.match(/^(?:"([^"]+)"|'([^']+)')(?=\.|$)/)
  if (quoted) return quoted[1] || quoted[2]
  const plain = rest.match(/^([^.]+)(?=\.|$)/)
  return plain ? plain[1].trim() : null
}

function extractMcpServers(text) {
  const lines = text.split(/(?<=\n)/)
  const blocks = new Map()
  let current = null

  for (const line of lines) {
    const section = parseSectionName(line.replace(/\r?\n$/, ""))
    if (section !== null) current = mcpServerFromSection(section)
    if (current) blocks.set(current, `${blocks.get(current) || ""}${line}`)
  }

  return Object.fromEntries(
    [...blocks.entries()].map(([name, raw]) => [name, { raw, sha256: sha256(raw.trimEnd()) }]),
  )
}

function normalizeServerList(value, available) {
  const requested = readJsonArg(value, "--servers-json", null)
  if (requested === null) return [...available].sort()
  if (!Array.isArray(requested) || requested.length === 0 || requested.some((item) => typeof item !== "string" || !item.trim())) {
    fail("--servers-json must be a non-empty JSON array of server names", 2)
  }
  return [...new Set(requested.map((item) => item.trim()))].sort()
}

function manifestPath(args) {
  const value = String(args.manifest || "").trim()
  if (!value) fail("--manifest is required", 2)
  return path.resolve(value)
}

function configPath(args) {
  const value = String(args.config || "").trim()
  if (!value) fail("--config is required", 2)
  return path.resolve(value)
}

function snapshot(args) {
  const routing = validateRoute(args)
  const config = configPath(args)
  const manifestFile = manifestPath(args)
  const operationId = String(args["operation-id"] || "").trim()
  if (!operationId) fail("--operation-id is required", 2)

  const text = fs.readFileSync(config, "utf8")
  const available = extractMcpServers(text)
  const selectedNames = normalizeServerList(args["servers-json"], Object.keys(available))
  const missing = selectedNames.filter((name) => !available[name])
  if (missing.length) fail("Requested MCP servers are absent from the source config", 75, { missing })

  const toolPrefixes = readJsonArg(args["tool-prefixes-json"], "--tool-prefixes-json", {})
  if (toolPrefixes === null || Array.isArray(toolPrefixes) || typeof toolPrefixes !== "object") {
    fail("--tool-prefixes-json must be a JSON object", 2)
  }

  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    operation_id: operationId,
    routing,
    source: {
      config_path: config,
      config_sha256: sha256(text),
    },
    servers: Object.fromEntries(
      selectedNames.map((name) => [name, {
        raw: available[name].raw,
        sha256: available[name].sha256,
        tool_prefixes: Array.isArray(toolPrefixes[name]) ? toolPrefixes[name] : [],
      }]),
    ),
    safeguards: {
      local_manifest_mode: "0600",
      manifest_may_contain_local_secret_material: true,
      commit_manifest_to_repository: false,
      restore_missing_only: true,
      overwrite_changed_server: false,
      whole_config_rollback: false,
      atomic_write_required: true,
    },
  }

  atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  emit({
    status: "snapshot_created",
    manifest: manifestFile,
    servers: selectedNames,
    config_sha256: manifest.source.config_sha256,
    warning: "Keep the manifest local with mode 0600; do not commit it because MCP tables may contain local authentication material.",
  })
}

function compareConfig(config, manifest) {
  const text = fs.readFileSync(config, "utf8")
  const current = extractMcpServers(text)
  const missing = []
  const changed = []
  const healthy = []

  for (const [name, expected] of Object.entries(manifest.servers || {})) {
    if (!current[name]) missing.push(name)
    else if (current[name].sha256 !== expected.sha256) {
      changed.push({ name, expected_sha256: expected.sha256, actual_sha256: current[name].sha256 })
    } else healthy.push(name)
  }

  return { text, current, missing, changed, healthy, config_sha256: sha256(text) }
}

function audit(args) {
  const routing = validateRoute(args)
  const config = configPath(args)
  const manifestFile = manifestPath(args)
  const manifest = readJson(manifestFile)
  const result = compareConfig(config, manifest)
  const drifted = result.missing.length > 0 || result.changed.length > 0

  emit({
    status: drifted ? "mcp_config_drift" : "mcp_config_intact",
    routing,
    config,
    manifest: manifestFile,
    config_sha256: result.config_sha256,
    expected_source_sha256: manifest.source?.config_sha256 || null,
    missing_servers: result.missing,
    changed_servers: result.changed,
    healthy_servers: result.healthy,
    mutation_authority: !drifted,
    continuity: drifted
      ? [
          "Keep existing healthy tasks running.",
          "Do not restart or replay unrelated operations.",
          "Restore only missing MCP tables through the guarded repair command.",
          "Treat changed MCP tables as a manual reconciliation event; do not overwrite them automatically.",
        ]
      : ["Continue verified MCP and connector workflows."],
  }, drifted ? 75 : 0)
}

function repair(args) {
  const routing = validateRoute(args)
  const config = configPath(args)
  const manifestFile = manifestPath(args)
  const manifest = readJson(manifestFile)
  const result = compareConfig(config, manifest)

  if (result.changed.length) {
    fail("One or more MCP server tables changed; refusing to overwrite a potentially legitimate update", 75, {
      changed_servers: result.changed,
      action: "Reconcile the changed server manually, create a new trusted snapshot, then rerun the post-restart canary.",
    })
  }
  if (result.missing.length === 0) {
    emit({ status: "repair_not_needed", routing, config, manifest: manifestFile, healthy_servers: result.healthy })
  }
  if (!args.execute || process.env.OPERATOR_AUTHORIZED_LOCAL_EXECUTOR !== "1") {
    fail("Repair requires --execute from an explicitly authorized local executor", 78, {
      missing_servers: result.missing,
      required_environment: "OPERATOR_AUTHORIZED_LOCAL_EXECUTOR=1",
    })
  }

  const backupDir = path.resolve(String(args["backup-dir"] || path.join(path.dirname(config), "operator-config-backups")))
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backup = path.join(backupDir, `${path.basename(config)}.${timestamp}.${result.config_sha256.slice(0, 12)}.bak`)
  fs.writeFileSync(backup, result.text, { mode: 0o600, flag: "wx" })

  const additions = result.missing.map((name) => {
    const raw = String(manifest.servers[name].raw || "")
    if (!raw.trim()) fail("Manifest contains an empty MCP server block", 75, { server: name })
    return raw.trim()
  }).join("\n\n")

  const nextText = `${result.text.trimEnd()}\n\n${additions}\n`
  atomicWrite(config, nextText)
  const verified = compareConfig(config, manifest)
  if (verified.missing.length || verified.changed.length) {
    fs.copyFileSync(backup, config)
    fail("Post-write verification failed; restored the pre-repair config backup", 75, {
      backup,
      missing_servers: verified.missing,
      changed_servers: verified.changed,
    })
  }

  const receipt = {
    schema_version: 1,
    status: "mcp_config_repaired",
    created_at: new Date().toISOString(),
    operation_id: manifest.operation_id,
    routing,
    config,
    manifest: manifestFile,
    backup,
    restored_servers: result.missing,
    before_sha256: result.config_sha256,
    after_sha256: verified.config_sha256,
    next_required_step: "Restart Desktop once, start a new task, and run post-restart-check against the actual tool inventory.",
  }
  const receiptFile = path.join(backupDir, `repair.${timestamp}.${sha256(JSON.stringify(receipt)).slice(0, 12)}.json`)
  atomicWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  emit({ ...receipt, receipt_file: receiptFile })
}

function collectToolNames(value) {
  if (Array.isArray(value)) return value.flatMap(collectToolNames)
  if (value && typeof value === "object") {
    const direct = [value.name, value.tool_name, value.id].filter((item) => typeof item === "string")
    return [...direct, ...Object.values(value).flatMap(collectToolNames)]
  }
  return typeof value === "string" ? [value] : []
}

function postRestartCheck(args) {
  const routing = validateRoute(args)
  const manifestFile = manifestPath(args)
  const inventoryFile = String(args["inventory-json"] || "").trim()
  if (!inventoryFile) fail("--inventory-json is required", 2)
  const manifest = readJson(manifestFile)
  const inventory = readJson(path.resolve(inventoryFile))
  const names = [...new Set(collectToolNames(inventory))]
  const missing = []
  const verified = []

  for (const [server, expected] of Object.entries(manifest.servers || {})) {
    const prefixes = Array.isArray(expected.tool_prefixes) ? expected.tool_prefixes.filter(Boolean) : []
    if (prefixes.length === 0) {
      missing.push({ server, reason: "no_tool_prefix_canary_defined" })
      continue
    }
    const matches = prefixes.filter((prefix) => names.some((name) => name.startsWith(prefix)))
    if (matches.length === 0) missing.push({ server, expected_prefixes: prefixes })
    else verified.push({ server, matched_prefixes: matches })
  }

  if (missing.length) {
    emit({
      status: "mcp_runtime_not_ready",
      routing,
      manifest: manifestFile,
      missing,
      verified,
      tool_count: names.length,
      mutation_authority: false,
      action_sequence: [
        "Do not recreate the operation or broaden filesystem/network permissions.",
        "Open Desktop MCP settings and re-enable only the missing approved server when its toggle reset.",
        "Start a brand-new task after the setting change.",
        "Capture a fresh tool inventory and rerun this check.",
        "Continue unrelated builds, deployments, and connectors through already verified routes.",
      ],
    }, 75)
  }

  emit({
    status: "mcp_runtime_verified",
    routing,
    manifest: manifestFile,
    verified,
    tool_count: names.length,
    mutation_authority: true,
  })
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
if (command === "snapshot") snapshot(args)
else if (command === "audit") audit(args)
else if (command === "repair") repair(args)
else if (command === "post-restart-check") postRestartCheck(args)
else fail("Use snapshot, audit, repair, or post-restart-check", 2)
