#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"

const EXIT_POLICY = 64
const EXIT_MALFORMED = 2
const EXIT_UNHEALTHY = 75
const PACKAGE_NAME = "OpenAI.Codex"

function parseArgs(argv) {
  const options = { json: false, fixture: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg === "--package-status-json") {
      const value = argv[i + 1]
      if (!value) throw new Error("--package-status-json requires a file path")
      options.fixture = value
      i += 1
      continue
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function emit(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  const lines = [
    `status: ${payload.status}`,
    `package: ${payload.package_name}`,
    `package_status: ${payload.package_status ?? "unknown"}`,
    `safe_to_launch_desktop: ${payload.safe_to_launch_desktop}`,
  ]
  if (payload.package_full_name) lines.push(`package_full_name: ${payload.package_full_name}`)
  if (payload.install_location) lines.push(`install_location: ${payload.install_location}`)
  if (payload.action) lines.push(`action: ${payload.action}`)
  process.stdout.write(`${lines.join("\n")}\n`)
}

function normalizePackageRecord(input) {
  const records = Array.isArray(input) ? input : [input]
  const matching = records.filter((record) => record && record.Name === PACKAGE_NAME)
  if (matching.length !== 1) {
    throw new Error(`expected exactly one ${PACKAGE_NAME} package, found ${matching.length}`)
  }

  const record = matching[0]
  const status = String(record.Status ?? "").trim()
  if (!status) throw new Error("package status is missing")

  return {
    name: PACKAGE_NAME,
    fullName: record.PackageFullName ? String(record.PackageFullName) : null,
    installLocation: record.InstallLocation ? String(record.InstallLocation) : null,
    status,
  }
}

async function readPackageStatus(options) {
  if (options.fixture) {
    return normalizePackageRecord(JSON.parse(await readFile(options.fixture, "utf8")))
  }

  if (process.platform !== "win32") return null

  const command = [
    "$ErrorActionPreference='Stop';",
    `$pkg = Get-AppxPackage -Name '${PACKAGE_NAME}';`,
    "if ($null -eq $pkg) { throw 'OpenAI.Codex package not found' };",
    "$pkg | Select-Object Name,PackageFullName,InstallLocation,@{Name='Status';Expression={$_.Status.ToString()}} | ConvertTo-Json -Compress",
  ].join(" ")

  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Get-AppxPackage failed: ${(result.stderr || result.stdout || "unknown error").trim()}`)
  }

  return normalizePackageRecord(JSON.parse(result.stdout))
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(EXIT_POLICY)
  }

  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/operator/codex-msix-package-guard.mjs [--json] [--package-status-json FILE]\n",
    )
    return
  }

  try {
    const pkg = await readPackageStatus(options)
    if (!pkg) {
      emit(
        {
          status: "not_applicable",
          package_name: PACKAGE_NAME,
          package_status: null,
          package_full_name: null,
          install_location: null,
          safe_to_launch_desktop: true,
          action: "non-Windows host; no MSIX package inspection required",
        },
        options.json,
      )
      return
    }

    const healthy = pkg.status.toLowerCase() === "ok"
    emit(
      {
        status: healthy ? "healthy" : "recovery_required",
        package_name: pkg.name,
        package_status: pkg.status,
        package_full_name: pkg.fullName,
        install_location: pkg.installLocation,
        safe_to_launch_desktop: healthy,
        action: healthy
          ? "Codex Desktop MSIX package integrity is healthy"
          : "Do not relaunch Codex Desktop. Preserve task and write state, stop orphaned Codex helpers, use an approved direct OpenAI CLI/WSL or authorized local route, and repair through the Microsoft Store or Windows Settings. Do not modify WindowsApps files or ACLs manually.",
      },
      options.json,
    )

    if (!healthy) process.exit(EXIT_UNHEALTHY)
  } catch (error) {
    emit(
      {
        status: "inspection_failed",
        package_name: PACKAGE_NAME,
        package_status: null,
        package_full_name: null,
        install_location: null,
        safe_to_launch_desktop: false,
        action: `Fail closed: ${error.message}`,
      },
      options?.json ?? false,
    )
    process.exit(EXIT_MALFORMED)
  }
}

await main()
