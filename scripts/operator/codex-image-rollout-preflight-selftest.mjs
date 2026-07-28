import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const script = path.resolve(process.argv[2] || new URL("./codex-image-rollout-preflight.mjs", import.meta.url).pathname)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-rollout-preflight-"))

function run(sessionsRoot, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, "--sessions-root", sessionsRoot, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPERATOR_CODEX_IMAGE_ROLLOUT_WARNING_MIB: "1",
      OPERATOR_CODEX_IMAGE_ROLLOUT_CRITICAL_MIB: "4",
      OPERATOR_CODEX_IMAGE_ROLLOUT_MAX_SCAN_MIB: "32",
      ...extraEnv,
    },
  })
  let parsed = null
  if (result.stdout.trim()) parsed = JSON.parse(result.stdout)
  return { ...result, parsed }
}

try {
  const clean = path.join(root, "clean")
  fs.mkdirSync(clean, { recursive: true })
  fs.writeFileSync(path.join(clean, "small.jsonl"), '{"type":"message","text":"ok"}\n')
  const cleanResult = run(clean)
  assert.equal(cleanResult.status, 0)
  assert.equal(cleanResult.parsed.desktop_safe_to_launch, true)
  assert.equal(cleanResult.parsed.status, "clean")

  const inline = path.join(root, "inline")
  fs.mkdirSync(inline, { recursive: true })
  fs.writeFileSync(
    path.join(inline, "image.jsonl"),
    `${"x".repeat(1024 * 1024)}data:image/png;base64,AAAA`,
  )
  const inlineResult = run(inline)
  assert.equal(inlineResult.status, 75)
  assert.equal(inlineResult.parsed.desktop_safe_to_launch, false)
  assert(inlineResult.parsed.findings.some((item) => item.code === "inline_image_rollout"))

  const oversized = path.join(root, "oversized")
  fs.mkdirSync(oversized, { recursive: true })
  fs.writeFileSync(path.join(oversized, "large.jsonl"), Buffer.alloc(5 * 1024 * 1024, 0x61))
  const oversizedResult = run(oversized)
  assert.equal(oversizedResult.status, 75)
  assert(oversizedResult.parsed.findings.some((item) => item.code === "oversized_rollout"))

  if (process.platform !== "win32") {
    const symlinked = path.join(root, "symlinked")
    fs.mkdirSync(symlinked, { recursive: true })
    fs.symlinkSync(path.join(clean, "small.jsonl"), path.join(symlinked, "linked.jsonl"))
    const symlinkResult = run(symlinked)
    assert.equal(symlinkResult.status, 75)
    assert(symlinkResult.parsed.findings.some((item) => item.code === "symlink_in_sessions"))
  }

  console.log("codex image-rollout preflight self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
