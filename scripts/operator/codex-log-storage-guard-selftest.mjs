import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const script = path.join(import.meta.dirname, "codex-log-storage-guard.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-log-storage-guard-"))

function run(sqliteHome, extra = []) {
  const result = spawnSync(process.execPath, [script, "--sqlite-home", sqliteHome, ...extra], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: root },
  })
  assert.equal(result.stderr, "")
  return { code: result.status, body: JSON.parse(result.stdout) }
}

try {
  const clean = path.join(root, "clean")
  fs.mkdirSync(clean)
  const cleanResult = run(clean)
  assert.equal(cleanResult.code, 0)
  assert.equal(cleanResult.body.status, "safe")

  const warning = path.join(root, "warning")
  fs.mkdirSync(warning)
  fs.writeFileSync(path.join(warning, "logs_2.sqlite"), "")
  fs.truncateSync(path.join(warning, "logs_2.sqlite"), 300 * 1024 ** 2)
  const warningResult = run(warning)
  assert.equal(warningResult.code, 0)
  assert.equal(warningResult.body.status, "warning")
  assert.ok(warningResult.body.warning_reasons.includes("logs_db_size_warning"))
  const strictWarning = run(warning, ["--fail-on-warning"])
  assert.equal(strictWarning.code, 75)

  const critical = path.join(root, "critical")
  fs.mkdirSync(critical)
  fs.writeFileSync(path.join(critical, "logs_2.sqlite"), "")
  fs.truncateSync(path.join(critical, "logs_2.sqlite"), 800 * 1024 ** 2)
  const criticalResult = run(critical)
  assert.equal(criticalResult.code, 75)
  assert.equal(criticalResult.body.status, "critical")
  assert.ok(criticalResult.body.critical_reasons.includes("logs_db_size_critical"))
  assert.equal(criticalResult.body.safe_to_mutate_logs_database_while_codex_is_running, false)

  const target = path.join(root, "target.sqlite")
  fs.writeFileSync(target, "fixture")
  const linked = path.join(root, "linked")
  fs.mkdirSync(linked)
  try {
    fs.symlinkSync(target, path.join(linked, "logs_2.sqlite"), "file")
    const linkedResult = run(linked)
    assert.equal(linkedResult.code, 75)
    assert.ok(linkedResult.body.critical_reasons.includes("database_path_not_regular_file"))
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error
  }

  console.log("codex log storage guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
