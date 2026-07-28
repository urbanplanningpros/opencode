#!/usr/bin/env node

import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const script = resolve(process.argv[2] ?? "scripts/operator/codex-msix-package-guard.mjs")
const root = await mkdtemp(join(tmpdir(), "codex-msix-guard-"))

async function runFixture(name, payload) {
  const path = join(root, `${name}.json`)
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 })
  return spawnSync(process.execPath, [script, "--json", "--package-status-json", path], {
    encoding: "utf8",
  })
}

function parse(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`invalid JSON output: ${result.stdout}\n${result.stderr}`)
  }
}

try {
  const healthy = await runFixture("healthy", {
    Name: "OpenAI.Codex",
    PackageFullName: "OpenAI.Codex_26.721.4979.0_x64__example",
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__example",
    Status: "Ok",
  })
  if (healthy.status !== 0 || parse(healthy).safe_to_launch_desktop !== true) {
    throw new Error("healthy package fixture did not pass")
  }

  const unhealthy = await runFixture("unhealthy", {
    Name: "OpenAI.Codex",
    PackageFullName: "OpenAI.Codex_26.721.4979.0_arm64__example",
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_arm64__example",
    Status: "Modified, NeedsRemediation",
  })
  const unhealthyBody = parse(unhealthy)
  if (unhealthy.status !== 75 || unhealthyBody.status !== "recovery_required") {
    throw new Error("unhealthy package fixture did not fail closed")
  }

  const duplicate = await runFixture("duplicate", [
    { Name: "OpenAI.Codex", Status: "Ok" },
    { Name: "OpenAI.Codex", Status: "Ok" },
  ])
  if (duplicate.status !== 2 || parse(duplicate).status !== "inspection_failed") {
    throw new Error("duplicate package fixture did not fail closed")
  }

  const missing = await runFixture("missing", { Name: "Other.Package", Status: "Ok" })
  if (missing.status !== 2 || parse(missing).status !== "inspection_failed") {
    throw new Error("missing package fixture did not fail closed")
  }

  process.stdout.write("codex-msix-package-guard self-test passed\n")
} finally {
  await rm(root, { recursive: true, force: true })
}
