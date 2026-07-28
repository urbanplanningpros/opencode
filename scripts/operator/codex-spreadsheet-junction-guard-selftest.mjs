#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = await mkdtemp(path.join(os.tmpdir(), "spreadsheet-junction-guard-"))
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-spreadsheet-junction-guard.mjs")
const runtime = path.join(root, "runtime")
const work = path.join(root, "work")
const junction = path.join(work, "node_modules")
const sentinel = path.join(runtime, "@oai", "artifact-tool", "package.json")

const run = (...args) => {
  const result = spawnSync(process.execPath, [script, "--allow-non-windows-fixture", "--json", ...args], {
    encoding: "utf8",
  })
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null }
}

try {
  await mkdir(path.dirname(sentinel), { recursive: true })
  await mkdir(work, { recursive: true })
  await writeFile(sentinel, '{"name":"@oai/artifact-tool"}\n')
  await symlink(runtime, junction, process.platform === "win32" ? "junction" : "dir")

  const inspection = run("--path", junction, "--expected-target-root", runtime)
  if (inspection.status !== 0 || inspection.json.status !== "verified") {
    throw new Error(`inspection failed: ${inspection.stderr || inspection.stdout}`)
  }

  const removal = run(
    "--path",
    junction,
    "--expected-target-root",
    runtime,
    "--unlink",
    "--confirm",
    inspection.json.confirmation_token,
  )
  if (removal.status !== 0 || removal.json.status !== "unlinked" || !removal.json.target_preserved) {
    throw new Error(`unlink failed: ${removal.stderr || removal.stdout}`)
  }
  if (!(await readFile(sentinel, "utf8")).includes("artifact-tool")) {
    throw new Error("shared runtime sentinel was not preserved")
  }

  await mkdir(junction)
  const ordinaryDirectory = run("--path", junction, "--expected-target-root", runtime)
  if (ordinaryDirectory.status !== 64 || ordinaryDirectory.json.status !== "rejected") {
    throw new Error("ordinary node_modules directory did not fail closed")
  }

  console.log("spreadsheet junction guard self-test passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
