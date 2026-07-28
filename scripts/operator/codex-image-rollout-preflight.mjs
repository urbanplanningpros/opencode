import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const argv = process.argv.slice(2)

function takeValue(name) {
  const index = argv.indexOf(name)
  if (index === -1) return null
  if (!argv[index + 1]) {
    console.error(`Missing value for ${name}.`)
    process.exit(2)
  }
  const value = argv[index + 1]
  argv.splice(index, 2)
  return value
}

function takeFlag(name) {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}

const jsonOutput = takeFlag("--json")
const requestedRoot = takeValue("--sessions-root")
if (argv.length > 0) {
  console.error(`Unknown arguments: ${argv.join(" ")}`)
  process.exit(2)
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, minimum), maximum)
}

const MiB = 1024 * 1024
const warningBytes = boundedInteger(process.env.OPERATOR_CODEX_IMAGE_ROLLOUT_WARNING_MIB, 64, 1, 4096) * MiB
const criticalBytes = boundedInteger(process.env.OPERATOR_CODEX_IMAGE_ROLLOUT_CRITICAL_MIB, 256, 2, 16384) * MiB
const maxFiles = boundedInteger(process.env.OPERATOR_CODEX_IMAGE_ROLLOUT_MAX_FILES, 20000, 1, 200000)
const maxCandidateScans = boundedInteger(process.env.OPERATOR_CODEX_IMAGE_ROLLOUT_MAX_CANDIDATE_SCANS, 100, 1, 1000)
const maxTotalScanBytes = boundedInteger(process.env.OPERATOR_CODEX_IMAGE_ROLLOUT_MAX_SCAN_MIB, 1024, 1, 16384) * MiB

if (criticalBytes <= warningBytes) {
  console.error("Critical rollout threshold must be greater than the warning threshold.")
  process.exit(2)
}

const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const sessionsRoot = path.resolve(requestedRoot || path.join(codexHome, "sessions"))

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function containsInlineImage(filePath, byteBudget) {
  const marker = Buffer.from("data:image/")
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  let tail = Buffer.alloc(0)
  let scanned = 0

  try {
    for await (const chunk of stream) {
      const remaining = byteBudget - scanned
      if (remaining <= 0) return { found: false, scanned, complete: false }
      const bounded = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      const combined = tail.length > 0 ? Buffer.concat([tail, bounded]) : bounded
      scanned += bounded.length
      if (combined.indexOf(marker) !== -1) return { found: true, scanned, complete: true }
      tail = combined.subarray(Math.max(0, combined.length - marker.length + 1))
      if (bounded.length < chunk.length) return { found: false, scanned, complete: false }
    }
    return { found: false, scanned, complete: true }
  } finally {
    stream.destroy()
  }
}

const findings = []
let filesVisited = 0
let candidateScans = 0
let scannedBytes = 0
let traversalTruncated = false
let scanBudgetExhausted = false

async function walk(directory) {
  if (filesVisited >= maxFiles) {
    traversalTruncated = true
    return
  }

  let entries
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (error) {
    findings.push({
      severity: "critical",
      code: "sessions_directory_unreadable",
      path: directory,
      message: String(error?.message || error),
    })
    return
  }

  for (const entry of entries) {
    if (filesVisited >= maxFiles) {
      traversalTruncated = true
      return
    }

    const candidate = path.resolve(directory, entry.name)
    if (!isInside(sessionsRoot, candidate)) {
      findings.push({ severity: "critical", code: "path_escape", path: candidate })
      continue
    }

    let stat
    try {
      stat = await fs.promises.lstat(candidate)
    } catch (error) {
      findings.push({ severity: "critical", code: "state_entry_unreadable", path: candidate, message: String(error?.message || error) })
      continue
    }

    if (stat.isSymbolicLink()) {
      findings.push({ severity: "critical", code: "symlink_in_sessions", path: candidate })
      continue
    }
    if (stat.isDirectory()) {
      await walk(candidate)
      continue
    }
    if (!stat.isFile() || !entry.name.endsWith(".jsonl")) continue

    filesVisited += 1
    if (stat.size < warningBytes) continue

    let imageScan = { found: false, scanned: 0, complete: false }
    if (candidateScans < maxCandidateScans && scannedBytes < maxTotalScanBytes) {
      const perFileBudget = Math.min(stat.size, maxTotalScanBytes - scannedBytes)
      candidateScans += 1
      imageScan = await containsInlineImage(candidate, perFileBudget)
      scannedBytes += imageScan.scanned
      if (!imageScan.complete && !imageScan.found) scanBudgetExhausted = true
    } else {
      scanBudgetExhausted = true
    }

    const severity = stat.size >= criticalBytes || imageScan.found || !imageScan.complete ? "critical" : "warning"
    const code = stat.size >= criticalBytes
      ? imageScan.found
        ? "oversized_inline_image_rollout"
        : "oversized_rollout"
      : imageScan.found
        ? "inline_image_rollout"
        : imageScan.complete
          ? "large_rollout"
          : "large_rollout_scan_incomplete"

    findings.push({
      severity,
      code,
      path: candidate,
      bytes: stat.size,
      inline_image_marker_found: imageScan.found,
      bytes_scanned: imageScan.scanned,
      scan_complete: imageScan.complete,
    })
  }
}

let rootStatus = "present"
try {
  const rootStat = await fs.promises.lstat(sessionsRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    findings.push({ severity: "critical", code: "invalid_sessions_root", path: sessionsRoot })
  } else {
    await walk(sessionsRoot)
  }
} catch (error) {
  if (error?.code === "ENOENT") rootStatus = "not_present"
  else findings.push({ severity: "critical", code: "sessions_root_unreadable", path: sessionsRoot, message: String(error?.message || error) })
}

if (traversalTruncated) findings.push({ severity: "critical", code: "file_traversal_limit_reached", limit: maxFiles })
if (scanBudgetExhausted) findings.push({ severity: "critical", code: "scan_budget_exhausted", max_total_scan_bytes: maxTotalScanBytes })

const criticalCount = findings.filter((item) => item.severity === "critical").length
const warningCount = findings.filter((item) => item.severity === "warning").length
const desktopSafeToLaunch = criticalCount === 0

const result = {
  schema_version: 1,
  status: desktopSafeToLaunch ? (warningCount > 0 ? "warning" : "clean") : "blocked",
  sessions_root: sessionsRoot,
  sessions_root_status: rootStatus,
  warning_threshold_bytes: warningBytes,
  critical_threshold_bytes: criticalBytes,
  files_visited: filesVisited,
  candidate_files_scanned: candidateScans,
  bytes_scanned: scannedBytes,
  desktop_safe_to_launch: desktopSafeToLaunch,
  findings,
  continuity_route: desktopSafeToLaunch
    ? "guarded_direct_openai"
    : "fresh_isolated_codex_home_or_explicitly_authorized_local_route",
  mutation_performed: false,
}

if (jsonOutput) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`Codex image-rollout preflight: ${result.status}`)
  console.log(`Sessions root: ${sessionsRoot}`)
  console.log(`Files visited: ${filesVisited}; critical: ${criticalCount}; warnings: ${warningCount}`)
  for (const finding of findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.code}${finding.path ? ` ${finding.path}` : ""}`)
  }
  if (!desktopSafeToLaunch) {
    console.error("Refusing Desktop admission for this state profile. Do not delete or rewrite rollout history. Preserve the profile, continue through a fresh isolated CODEX_HOME or explicitly authorized local route, and reconcile uncertain writes before replay.")
  }
}

process.exit(desktopSafeToLaunch ? 0 : 75)
