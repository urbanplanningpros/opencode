import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(scriptDir, "codex-memory-safe-launch.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-safe-launch-"))
const fakeLauncher = path.join(root, "fake-base-launcher.mjs")
const recordFile = path.join(root, "record.json")

fs.writeFileSync(
  fakeLauncher,
  `import fs from "node:fs"\nconst args = process.argv.slice(2)\nif (args.includes("--dry-run")) {\n  console.log(JSON.stringify({ binary: "codex", args, multi_agent_v2: false, agents_enabled: false }))\n  process.exit(0)\n}\nfs.writeFileSync(process.env.OPERATOR_TEST_RECORD, JSON.stringify({ args, memory_guard: process.env.OPERATOR_CODEX_NATIVE_MEMORY_GUARD_ACTIVE }))\n`,
  { mode: 0o600 },
)

function run(args) {
  return spawnSync(process.execPath, [guard, ...args], {
    cwd: root,
    env: {
      ...process.env,
      OPERATOR_CODEX_BASE_LAUNCHER: fakeLauncher,
      OPERATOR_TEST_RECORD: recordFile,
    },
    encoding: "utf8",
  })
}

try {
  const dryRun = run(["--dry-run", "--", "exec", "--ephemeral", "-"])
  assert.equal(dryRun.status, 0, dryRun.stderr)
  const summary = JSON.parse(dryRun.stdout)
  assert.equal(summary.native_memories, false)
  assert.equal(summary.memory_consolidation_multi_agent_guard, true)
  assert.equal(summary.multi_agent_v2, false)
  assert.equal(summary.agents_enabled, false)
  const memoryDisableIndex = summary.args.indexOf("--disable")
  assert.notEqual(memoryDisableIndex, -1)
  assert.equal(summary.args[memoryDisableIndex + 1], "memories")

  const enabledByFlag = run(["--", "--enable", "memories", "exec", "-"])
  assert.equal(enabledByFlag.status, 64)
  assert.match(enabledByFlag.stderr, /Refusing to enable native Codex memories/)

  const enabledByConfig = run(["--", "-c", "features.memories=true", "exec", "-"])
  assert.equal(enabledByConfig.status, 64)
  assert.match(enabledByConfig.stderr, /Refusing to enable native Codex memories/)

  const delegated = run(["--", "exec", "--ephemeral", "-"])
  assert.equal(delegated.status, 0, delegated.stderr)
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"))
  assert.equal(record.memory_guard, "1")
  const delegatedMemoryDisableIndex = record.args.indexOf("--disable")
  assert.notEqual(delegatedMemoryDisableIndex, -1)
  assert.equal(record.args[delegatedMemoryDisableIndex + 1], "memories")
  assert.deepEqual(record.args.slice(-3), ["exec", "--ephemeral", "-"])

  console.log("codex-memory-safe-launch self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
