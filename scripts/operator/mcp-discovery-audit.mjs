import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function parseArgs(argv) {
  const result = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) {
      result._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      result[key] = true
      continue
    }
    result[key] = next
    index += 1
  }
  return result
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function isRelativeCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return false
  if (path.isAbsolute(command)) return false
  if (/^[A-Za-z]:[\\/]/.test(command)) return false
  return command.startsWith(".") || command.includes("/") || command.includes("\\")
}

function copyBackup(file, root, codexHome) {
  const relative = path.relative(codexHome, file)
  const target = path.join(root, relative.startsWith("..") ? path.basename(file) : relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(file, target)
  return target
}

function walk(root, predicate, found = []) {
  if (!fs.existsSync(root)) return found
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && predicate(full)) found.push(full)
    }
  }
  return found
}

function parseTomlBlocks(text) {
  const matches = [...text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)]
  return matches.map((match, index) => ({
    section: match[1],
    start: match.index,
    end: index + 1 < matches.length ? matches[index + 1].index : text.length,
    text: text.slice(match.index, index + 1 < matches.length ? matches[index + 1].index : text.length),
  }))
}

function tomlValue(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = block.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "m"))
  if (!match) return undefined
  const raw = match[1].trim()
  if (raw === "true") return true
  if (raw === "false") return false
  const quoted = raw.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : raw
}

function auditToml(file, serverName) {
  if (!fs.existsSync(file)) return { findings: [], transformed: null }
  const original = fs.readFileSync(file, "utf8")
  const findings = []
  const removals = []
  for (const block of parseTomlBlocks(original)) {
    const match = block.section.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|(.+))$/)
    if (!match) continue
    const name = (match[1] || match[2] || match[3] || "").trim()
    if (serverName && name !== serverName) continue
    const enabled = tomlValue(block.text, "enabled")
    const command = tomlValue(block.text, "command")
    const cwd = tomlValue(block.text, "cwd")
    const risky = enabled === false && (isRelativeCommand(command) || cwd === ".")
    if (!risky) continue
    findings.push({ type: "disabled_toml_server", file, server: name, command, cwd, enabled })
    removals.push({ start: block.start, end: block.end })
  }
  if (removals.length === 0) return { findings, transformed: null }
  let transformed = original
  for (const removal of removals.sort((a, b) => b.start - a.start)) {
    transformed = `${transformed.slice(0, removal.start)}${transformed.slice(removal.end)}`
  }
  transformed = transformed.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
  return { findings, transformed }
}

function auditJson(file, serverName) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    return { findings: [{ type: "invalid_json", file, error: error.message }], transformed: null }
  }
  const servers = parsed?.mcpServers
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { findings: [], transformed: null }
  const findings = []
  const remove = []
  for (const [name, definition] of Object.entries(servers)) {
    if (serverName && name !== serverName) continue
    if (!definition || typeof definition !== "object") continue
    const command = definition.command
    const cwd = definition.cwd
    const risky = isRelativeCommand(command) || cwd === "."
    if (!risky) continue
    findings.push({ type: "discoverable_json_server", file, server: name, command, cwd })
    remove.push(name)
  }
  if (remove.length === 0) return { findings, transformed: null }
  const transformed = structuredClone(parsed)
  for (const name of remove) delete transformed.mcpServers[name]
  return { findings, transformed: `${JSON.stringify(transformed, null, 2)}\n` }
}

const args = parseArgs(process.argv.slice(2))
const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const serverName = String(args.server || "computer-use")
const apply = Boolean(args.apply)
const quarantineCache = Boolean(args["quarantine-cache"])
const jsonOutput = Boolean(args.json)
const configFile = path.join(codexHome, "config.toml")
const jsonRoots = [path.join(codexHome, "plugins", "cache"), path.join(codexHome, ".tmp", "bundled-marketplaces")]
const jsonFiles = jsonRoots.flatMap((root) => walk(root, (file) => path.basename(file) === ".mcp.json"))
const configAudit = auditToml(configFile, serverName)
const jsonAudits = jsonFiles.map((file) => ({ file, ...auditJson(file, serverName) }))
const findings = [...configAudit.findings, ...jsonAudits.flatMap((audit) => audit.findings)]
const modified = []
let backupRoot = null

if (apply && findings.length > 0) {
  backupRoot = path.join(codexHome, "operator-backups", "mcp-discovery", timestamp())
  if (configAudit.transformed !== null) {
    const backup = copyBackup(configFile, backupRoot, codexHome)
    fs.writeFileSync(configFile, configAudit.transformed, { mode: fs.statSync(configFile).mode })
    modified.push({ file: configFile, backup, action: "removed_disabled_toml_server" })
  }
  if (quarantineCache) {
    for (const audit of jsonAudits) {
      if (audit.transformed === null || audit.findings.length === 0) continue
      const backup = copyBackup(audit.file, backupRoot, codexHome)
      fs.writeFileSync(audit.file, audit.transformed, { mode: fs.statSync(audit.file).mode })
      modified.push({ file: audit.file, backup, action: "removed_discoverable_cache_server" })
    }
  }
  fs.mkdirSync(backupRoot, { recursive: true })
  fs.writeFileSync(
    path.join(backupRoot, "manifest.json"),
    `${JSON.stringify({ codex_home: codexHome, server: serverName, findings, modified, created_at: new Date().toISOString() }, null, 2)}\n`,
  )
}

const remainingConfig = auditToml(configFile, serverName).findings
const remainingJson = jsonFiles.flatMap((file) => auditJson(file, serverName).findings)
const remaining = [...remainingConfig, ...remainingJson]
const report = {
  codex_home: codexHome,
  server: serverName,
  apply,
  quarantine_cache: quarantineCache,
  findings,
  modified,
  backup_root: backupRoot,
  remaining,
  safe_for_third_party_discovery: remaining.length === 0,
  required_host_control:
    remaining.length > 0
      ? "Disable third-party auto-import/auto-spawn of agent MCP configs until remaining findings are removed."
      : null,
}

if (jsonOutput) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`Codex MCP discovery audit: ${findings.length} finding(s), ${modified.length} modified file(s)`)
  if (backupRoot) console.log(`Backup: ${backupRoot}`)
  for (const finding of remaining) console.log(`- ${finding.type}: ${finding.file} (${finding.server || "unknown"})`)
}

process.exit(remaining.length === 0 ? 0 : 2)
