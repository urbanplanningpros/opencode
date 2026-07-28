#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const script = resolve("scripts/operator/codex-safe-clean-python-bytecode.mjs")
const tempRoot = await mkdtemp(join(tmpdir(), "codex-safe-clean-"))

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== expectedStatus) {
    throw new Error(
      `Unexpected exit ${result.status}; expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result
}

function runGit(args, expectedStatus = 0) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== expectedStatus) {
    throw new Error(
      `Unexpected git exit ${result.status}; expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

try {
  runGit(["init", tempRoot])
  runGit(["-C", tempRoot, "config", "user.email", "operator@example.invalid"])
  runGit(["-C", tempRoot, "config", "user.name", "Operator Selftest"])

  await mkdir(join(tempRoot, "src", "__pycache__"), { recursive: true })
  await mkdir(join(tempRoot, "cache"), { recursive: true })
  await writeFile(join(tempRoot, "src", "app.py"), "print('keep')\n")
  await writeFile(join(tempRoot, "src", "__pycache__", "app.pyc"), "bytecode")
  await writeFile(join(tempRoot, "cache", "legacy.pyo"), "optimized")
  await writeFile(join(tempRoot, "cache", "not-bytecode.pyc.txt"), "keep")
  await writeFile(join(tempRoot, ".git", "objects", "must-survive.pyc"), "git-data")

  const dryRun = run(["--root", tempRoot, "--json"])
  const report = JSON.parse(dryRun.stdout)
  if (report.status !== "dry_run_complete" || report.candidate_count !== 2) {
    throw new Error(`Unexpected dry-run report: ${dryRun.stdout}`)
  }
  if (!(await exists(join(tempRoot, "src", "__pycache__", "app.pyc")))) {
    throw new Error("Dry run deleted a candidate")
  }

  const manifest = JSON.parse(await readFile(report.manifest_path, "utf8"))
  run([
    "--execute",
    "--manifest",
    report.manifest_path,
    "--confirm",
    manifest.confirmation_token,
    "--json",
  ])

  if (await exists(join(tempRoot, "src", "__pycache__", "app.pyc"))) throw new Error(".pyc was not deleted")
  if (await exists(join(tempRoot, "cache", "legacy.pyo"))) throw new Error(".pyo was not deleted")
  if (!(await exists(join(tempRoot, "src", "app.py")))) throw new Error("Source file was deleted")
  if (!(await exists(join(tempRoot, "cache", "not-bytecode.pyc.txt")))) throw new Error("Non-bytecode file was deleted")
  if (!(await exists(join(tempRoot, ".git", "objects", "must-survive.pyc")))) throw new Error(".git file was deleted")

  await writeFile(join(tempRoot, "tracked.pyc"), "tracked-bytecode")
  runGit(["-C", tempRoot, "add", "tracked.pyc"])
  const blocked = run(["--root", tempRoot, "--json"], 2)
  const blockedReport = JSON.parse(blocked.stdout)
  if (blockedReport.status !== "blocked" || !blockedReport.blocked_tracked_paths.includes("tracked.pyc")) {
    throw new Error(`Tracked-file protection did not engage: ${blocked.stdout}`)
  }
  if (!(await exists(join(tempRoot, "tracked.pyc")))) throw new Error("Tracked bytecode file was deleted")

  console.log("codex-safe-clean-python-bytecode self-test passed")
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
