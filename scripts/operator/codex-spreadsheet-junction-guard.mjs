#!/usr/bin/env node

import { createHash } from "node:crypto"
import { lstat, mkdir, readlink, realpath, stat, unlink } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const args = process.argv.slice(2)
const value = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const has = (name) => args.includes(name)
const fail = (message, code = 64, details = {}) => {
  const result = { status: "rejected", message, ...details }
  if (has("--json")) console.log(JSON.stringify(result, null, 2))
  else console.error(message)
  process.exit(code)
}
const within = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

if (process.platform !== "win32" && !has("--allow-non-windows-fixture")) {
  fail("This guard is intended for Windows spreadsheet junction workflows.")
}

const requestedPath = value("--path")
const requestedTargetRoot = value("--expected-target-root") ?? process.env.OPERATOR_SPREADSHEET_SHARED_RUNTIME_ROOT
if (!requestedPath) fail("Missing --path for the exact node_modules junction.", 2)
if (!requestedTargetRoot) fail("Missing --expected-target-root or OPERATOR_SPREADSHEET_SHARED_RUNTIME_ROOT.", 2)

const inspect = async () => {
  const junctionPath = path.resolve(requestedPath)
  const expectedTargetRoot = await realpath(path.resolve(requestedTargetRoot)).catch(() => null)
  if (!expectedTargetRoot) fail("The expected shared runtime root does not exist.", 64, { requested_target_root: requestedTargetRoot })
  if (path.basename(junctionPath).toLowerCase() !== "node_modules") {
    fail("Refusing a link whose final path component is not node_modules.", 64, { junction_path: junctionPath })
  }

  const link = await lstat(junctionPath).catch(() => null)
  if (!link) fail("The requested junction does not exist.", 64, { junction_path: junctionPath })
  if (!link.isSymbolicLink()) {
    fail("Refusing to act because the path is not a symbolic link or Windows junction.", 64, { junction_path: junctionPath })
  }

  const rawTarget = await readlink(junctionPath)
  const targetPath = await realpath(path.resolve(path.dirname(junctionPath), rawTarget)).catch(() => null)
  if (!targetPath) fail("The junction target cannot be resolved.", 64, { junction_path: junctionPath, raw_target: rawTarget })
  if (!within(expectedTargetRoot, targetPath)) {
    fail("The junction target is outside the approved shared runtime root.", 64, {
      junction_path: junctionPath,
      target_path: targetPath,
      expected_target_root: expectedTargetRoot,
    })
  }

  const [parentState, targetState] = await Promise.all([stat(path.dirname(junctionPath)), stat(targetPath)])
  const sameVolume = String(parentState.dev) === String(targetState.dev)
  const evidence = {
    junction_path: junctionPath,
    target_path: targetPath,
    expected_target_root: expectedTargetRoot,
    link_mtime_ms: link.mtimeMs,
    link_size: link.size,
  }

  return {
    status: sameVolume ? "verified" : "cross_volume_blocked",
    same_volume: sameVolume,
    safe_for_spreadsheet_runtime: sameVolume,
    safe_to_unlink_exact_link: true,
    confirmation_token: `UNLINK_SPREADSHEET_JUNCTION:${digest(evidence)}`,
    ...evidence,
  }
}

const result = await inspect()
if (!has("--unlink")) {
  if (has("--json")) console.log(JSON.stringify(result, null, 2))
  else console.log(`${result.status}: ${result.junction_path} -> ${result.target_path}`)
  process.exit(result.same_volume ? 0 : 75)
}

if (value("--confirm") !== result.confirmation_token) {
  fail("The confirmation token does not match the current junction evidence.", 64, {
    junction_path: result.junction_path,
    required_confirmation_token: result.confirmation_token,
  })
}

const revalidated = await inspect()
if (revalidated.confirmation_token !== result.confirmation_token) {
  fail("The junction changed after inspection; refusing to unlink it.", 75, { junction_path: result.junction_path })
}

await unlink(result.junction_path)
const linkStillExists = await lstat(result.junction_path).then(() => true).catch(() => false)
if (linkStillExists) fail("The exact junction still exists after unlink.", 75, { junction_path: result.junction_path })
await stat(result.target_path).catch(() => fail("The shared runtime target is missing after unlink.", 75, { target_path: result.target_path }))

const completed = {
  ...result,
  status: "unlinked",
  target_preserved: true,
  recursive_operation_used: false,
}
if (has("--json")) console.log(JSON.stringify(completed, null, 2))
else console.log(`unlinked: ${result.junction_path}; target preserved: ${result.target_path}`)
