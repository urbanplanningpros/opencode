#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

function parseArgs(values) {
  const args = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2).replaceAll("-", "_")
    const next = values[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function octalMode(stats) {
  return (stats.mode & 0o777).toString(8).padStart(4, "0")
}

const args = parseArgs(process.argv.slice(2))
const codexHome = args.codex_home ? path.resolve(String(args.codex_home)) : ""
if (!codexHome) {
  console.error("Usage: node scripts/operator/codex-macos-global-state-permission-guard.mjs --codex-home <path> [--repair] [--json]")
  process.exit(2)
}

const blocked = []
const remediation = []
const warnings = []
const inspected = []

let homeStats
try {
  homeStats = fs.lstatSync(codexHome)
} catch (error) {
  console.error(`Unable to inspect CODEX_HOME: ${error.message}`)
  process.exit(2)
}

if (homeStats.isSymbolicLink()) blocked.push("codex_home_must_not_be_a_symlink")
if (!homeStats.isDirectory()) blocked.push("codex_home_must_be_a_directory")

const targets = [
  path.join(codexHome, ".codex-global-state.json"),
  path.join(codexHome, ".codex-global-state.json.bak"),
]

if (args.repair && blocked.length === 0) {
  fs.chmodSync(codexHome, 0o700)
  for (const target of targets) {
    let stats
    try {
      stats = fs.lstatSync(target)
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    if (stats.isSymbolicLink()) {
      blocked.push(`global_state_target_is_symlink:${path.basename(target)}`)
      continue
    }
    if (!stats.isFile()) {
      blocked.push(`global_state_target_not_regular_file:${path.basename(target)}`)
      continue
    }
    fs.chmodSync(target, 0o600)
  }
}

homeStats = fs.lstatSync(codexHome)
const homeMode = octalMode(homeStats)
inspected.push({ path: codexHome, type: "directory", mode: homeMode })
if (homeMode !== "0700") remediation.push("set_codex_home_mode_0700")

for (const target of targets) {
  let stats
  try {
    stats = fs.lstatSync(target)
  } catch (error) {
    if (error.code === "ENOENT") {
      warnings.push(`global_state_target_missing:${path.basename(target)}`)
      continue
    }
    throw error
  }
  const name = path.basename(target)
  if (stats.isSymbolicLink()) {
    blocked.push(`global_state_target_is_symlink:${name}`)
    inspected.push({ path: target, type: "symlink", mode: octalMode(stats) })
    continue
  }
  if (!stats.isFile()) {
    blocked.push(`global_state_target_not_regular_file:${name}`)
    inspected.push({ path: target, type: "other", mode: octalMode(stats) })
    continue
  }
  const mode = octalMode(stats)
  inspected.push({ path: target, type: "file", mode })
  if (mode !== "0600") remediation.push(`set_global_state_mode_0600:${name}`)
}

if (remediation.length === 0 && blocked.length === 0) {
  warnings.push("upstream_atomic_writer_fix_still_required_to_preserve_0600_after_every_rewrite")
  warnings.push("run_this_guard_before_and_after_desktop_sessions_until_a_fixed_stable_build_is_pinned")
}

const unique = (values) => [...new Set(values)]
const result = {
  status: blocked.length > 0 ? "blocked" : remediation.length > 0 ? "remediation_required" : "compatible",
  blocked: unique(blocked),
  remediation: unique(remediation),
  warnings: unique(warnings),
  inspected,
  repaired: args.repair === true,
  upstream_baseline: "openai/codex#36123",
}

if (args.json) console.log(JSON.stringify(result, null, 2))
else console.log(`${result.status}: ${[...result.blocked, ...result.remediation].join(", ") || "verified"}`)
process.exit(result.status === "compatible" ? 0 : result.status === "remediation_required" ? 75 : 64)
