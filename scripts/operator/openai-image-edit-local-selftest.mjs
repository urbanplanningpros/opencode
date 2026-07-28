import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openai-image-edit-"))
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const images = Array.from({ length: 4 }, (_, index) => {
  const file = path.join(root, `input-${index + 1}.png`)
  fs.writeFileSync(file, image)
  return file
})
const output = path.join(root, "output.png")
const record = {
  operation_id: "op-image-edit-test",
  idempotency_key: "idem-image-edit-test",
  action: "openai_image_edit",
  payload: {
    prompt: "Arrange these products in a gift basket with the label Relax & Unwind.",
    images,
    output_path: output,
  },
}
const script = path.resolve(import.meta.dirname, "openai-image-edit-local.mjs")
const baseEnv = {
  ...process.env,
  OPERATOR_IMAGE_INPUT_ROOTS: root,
  OPERATOR_IMAGE_OUTPUT_ROOTS: root,
  OPERATOR_STATE_DIR: path.join(root, "state"),
  OPERATOR_OPENAI_IMAGE_EDIT_DRY_RUN: "true",
}

const ok = spawnSync(process.execPath, [script], {
  input: JSON.stringify(record),
  encoding: "utf8",
  env: baseEnv,
})
assert.equal(ok.status, 0, ok.stderr)
const result = JSON.parse(ok.stdout)
assert.equal(result.verified, true)
assert.equal(result.dry_run, true)
assert.equal(result.reference_count, 4)
assert.equal(result.model, "gpt-5.6")
assert.equal(result.endpoint, "https://api.openai.com/v1/responses")
assert.equal(fs.existsSync(output), false)

const gateway = spawnSync(process.execPath, [script], {
  input: JSON.stringify(record),
  encoding: "utf8",
  env: { ...baseEnv, OPERATOR_OPENAI_API_BASE: "https://gateway.example/v1" },
})
assert.notEqual(gateway.status, 0)
assert.match(gateway.stderr, /Only the direct OpenAI API endpoint is allowed/)

const excluded = spawnSync(process.execPath, [script], {
  input: JSON.stringify({ ...record, payload: { ...record.payload, model: "claude-example" } }),
  encoding: "utf8",
  env: baseEnv,
})
assert.notEqual(excluded.status, 0)
assert.match(excluded.stderr, /Prohibited model or route/)

const outside = spawnSync(process.execPath, [script], {
  input: JSON.stringify({ ...record, payload: { ...record.payload, output_path: path.join(os.tmpdir(), "outside.png") } }),
  encoding: "utf8",
  env: baseEnv,
})
assert.notEqual(outside.status, 0)
assert.match(outside.stderr, /output directory is outside approved roots/)

fs.rmSync(root, { recursive: true, force: true })
console.log("direct OpenAI multi-reference image-edit self-test passed")
