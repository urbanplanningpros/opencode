import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function readJsonFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular non-symlink file`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function inspectWindowsWorkspace(workspace) {
  const shell = process.env.PWSH_EXE || (process.platform === "win32" ? "powershell.exe" : "pwsh")
  const escaped = workspace.replaceAll("'", "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$item = Get-Item -LiteralPath '${escaped}'`,
    "$root = [System.IO.Path]::GetPathRoot($item.FullName)",
    "$device = $root.TrimEnd('\\')",
    "$disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$device'\"",
    "[pscustomobject]@{",
    "  workspace = $item.FullName",
    "  drive_root = $root",
    "  drive_type = if ($disk) { [int]$disk.DriveType } else { $null }",
    "  file_system = if ($disk) { [string]$disk.FileSystem } else { $null }",
    "  provider = [string]$item.PSDrive.Provider.Name",
    "} | ConvertTo-Json -Compress",
  ].join("; ")

  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    shell: false,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "Windows filesystem inspection failed").trim()
    throw new Error(detail)
  }
  return JSON.parse(String(result.stdout).trim())
}

function readSandboxEvidence() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  const sandboxDir = path.join(codexHome, ".sandbox")
  const evidence = { sandbox_error: null, matched_log: null }
  const setupError = path.join(sandboxDir, "setup_error.json")

  try {
    if (fs.existsSync(setupError)) evidence.sandbox_error = fs.readFileSync(setupError, "utf8")
  } catch {
    // A missing or unreadable optional diagnostic must not mutate the workspace.
  }

  try {
    if (!fs.existsSync(sandboxDir)) return evidence
    const logs = fs
      .readdirSync(sandboxDir)
      .filter((name) => /^sandbox\..+\.log$/i.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(sandboxDir, name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, 3)

    for (const log of logs) {
      const content = fs.readFileSync(path.join(sandboxDir, log.name), "utf8")
      if (/SetNamedSecurityInfoW failed:\s*87|setup refresh had errors|helper_unknown_error/i.test(content)) {
        evidence.matched_log = log.name
        evidence.sandbox_error = `${evidence.sandbox_error || ""}\n${content.slice(-12000)}`
        break
      }
    }
  } catch {
    // Optional diagnostics only.
  }
  return evidence
}

const args = parseArgs(process.argv.slice(2))
const workspace = path.resolve(String(args.workspace || process.cwd()))
const prohibited = /(anthropic|claude|manus|openrouter|bedrock|vertex|copilot|gateway|auto[-_ ]?select)/i
const routingMetadata = JSON.stringify({
  provider: args.provider || process.env.OPERATOR_PROVIDER,
  route: args.route || process.env.OPERATOR_ROUTE,
  gateway: process.env.OPERATOR_GATEWAY,
})

if (prohibited.test(routingMetadata)) {
  console.error(JSON.stringify({ admitted: false, reason: "prohibited_route_metadata" }, null, 2))
  process.exit(64)
}

let stat
try {
  stat = fs.lstatSync(workspace)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workspace must be a regular non-symlink directory")
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_workspace", detail: error.message }, null, 2))
  process.exit(2)
}

let evidence
try {
  evidence = args.evidence ? readJsonFile(path.resolve(String(args.evidence))) : null
} catch (error) {
  console.error(JSON.stringify({ admitted: false, reason: "invalid_evidence", detail: error.message }, null, 2))
  process.exit(2)
}

if (!evidence && process.platform !== "win32") {
  console.log(
    JSON.stringify(
      {
        admitted: true,
        reason: "non_windows_workspace",
        workspace,
        protocol: "Continue through the guarded direct OpenAI or explicitly authorized local route.",
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

try {
  evidence = evidence || { ...inspectWindowsWorkspace(workspace), ...readSandboxEvidence() }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        admitted: false,
        reason: "filesystem_capability_unverified",
        detail: error.message,
        workspace,
        protocol:
          "Withhold only Windows Desktop sandboxed writes for this workspace. Use a local NTFS/ReFS mirror or the approved VPS/local executor and preserve operation IDs, idempotency keys, and state.",
      },
      null,
      2,
    ),
  )
  process.exit(75)
}

const driveType = Number(evidence.drive_type)
const fileSystem = String(evidence.file_system || "").toUpperCase()
const provider = String(evidence.provider || "")
const sandboxText = String(evidence.sandbox_error || "")
const aclFailure = /SetNamedSecurityInfoW failed:\s*87|setup refresh had errors|helper_unknown_error/i.test(sandboxText)
const supportedLocalFilesystem = driveType === 3 && ["NTFS", "REFS"].includes(fileSystem) && /filesystem/i.test(provider)
const admitted = supportedLocalFilesystem && !aclFailure

const report = {
  admitted,
  reason: admitted ? "local_acl_capable_workspace" : aclFailure ? "windows_sandbox_acl_failure" : "virtual_or_acl_incompatible_workspace",
  workspace,
  drive_type: Number.isFinite(driveType) ? driveType : null,
  file_system: evidence.file_system ?? null,
  provider: evidence.provider ?? null,
  matched_log: evidence.matched_log ?? null,
  protocol: admitted
    ? "Permit guarded Windows Desktop writes and keep independent post-write verification enabled."
    : "Do not retry the hanging Desktop write. Checkpoint task state, reconcile uncertain writes, move or mirror the repository to a local NTFS/ReFS workspace, execute through the guarded route, then synchronize ordinary files back to the virtual drive after verification.",
}

const output = JSON.stringify(report, null, 2)
if (admitted || args.json) console.log(output)
else console.error(output)
process.exit(admitted ? 0 : 75)
