import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-browser-mobile-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-mobile-guard-"))
let checks = 0

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [guard, ...args], { encoding: "utf8" })
  assert.equal(result.status, expected, `unexpected exit ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  checks += 1
  const raw = expected === 0 ? result.stdout : result.stderr || result.stdout
  return JSON.parse(raw)
}

try {
  const downloads = path.join(root, "downloads")
  const artifacts = path.join(root, "artifacts")
  fs.mkdirSync(downloads)
  const source = path.join(downloads, "probe.txt")
  fs.writeFileSync(source, "probe")

  const plan = run(["browser-plan", "--operation-id", "op-1", "--build", "26.727.40816"])
  assert.equal(plan.status, "browser_download_shim_ready")
  assert.equal(plan.safeguards.prohibit_duplicate_download_retry, true)

  const receipt = run([
    "download-receipt",
    "--operation-id", "op-1",
    "--source-path", source,
    "--artifact-dir", artifacts,
    "--allowed-roots-json", JSON.stringify([downloads]),
    "--expected-filename", "probe.txt",
  ])
  assert.equal(receipt.status, "artifact_captured")
  assert.equal(receipt.download.sha256, crypto.createHash("sha256").update("probe").digest("hex"))
  assert.equal(fs.readFileSync(receipt.download.destination, "utf8"), "probe")

  const repeat = run([
    "download-receipt",
    "--operation-id", "op-1",
    "--source-path", source,
    "--artifact-dir", artifacts,
    "--allowed-roots-json", JSON.stringify([downloads]),
  ])
  assert.equal(repeat.download.destination, receipt.download.destination)

  const outside = path.join(root, "outside.txt")
  fs.writeFileSync(outside, "outside")
  run([
    "download-receipt",
    "--operation-id", "op-outside",
    "--source-path", outside,
    "--artifact-dir", artifacts,
    "--allowed-roots-json", JSON.stringify([downloads]),
  ], 78)

  const link = path.join(downloads, "link.txt")
  fs.symlinkSync(source, link)
  run([
    "download-receipt",
    "--operation-id", "op-link",
    "--source-path", link,
    "--artifact-dir", artifacts,
    "--allowed-roots-json", JSON.stringify([downloads]),
  ], 78)

  run(["browser-plan", "--operation-id", "bad-route", "--model", "auto"], 78)
  run(["browser-plan", "--operation-id", "bad-gateway", "--gateway", "some-gateway"], 78)
  run(["browser-plan", "--operation-id", "bad-fallback", "--fallbacks", "configured"], 78)

  const auth = path.join(root, "authoritative.json")
  const selected = path.join(root, "selected.json")
  const base = {
    present: true,
    project_id: "project-123",
    host_id: "host-abc",
    worktree_root: path.join(root, "repo"),
    head_sha: "0123456789abcdef",
    display_name: "Renamed Project",
  }
  fs.writeFileSync(auth, JSON.stringify(base))
  fs.writeFileSync(selected, JSON.stringify({ ...base, display_name: "Old Project Name" }))
  const verified = run([
    "mobile-project-check",
    "--operation-id", "mobile-1",
    "--authoritative", auth,
    "--selected", selected,
  ])
  assert.equal(verified.status, "mobile_destination_verified")
  assert.equal(verified.mutation_authority, true)

  fs.writeFileSync(selected, JSON.stringify({ ...base, project_id: "stale-project" }))
  const stale = run([
    "mobile-project-check",
    "--operation-id", "mobile-stale",
    "--authoritative", auth,
    "--selected", selected,
  ], 75)
  assert.equal(stale.status, "mobile_catalog_untrusted")

  fs.writeFileSync(selected, JSON.stringify({ display_name: "Name Only" }))
  run([
    "mobile-project-check",
    "--operation-id", "mobile-name-only",
    "--authoritative", auth,
    "--selected", selected,
  ], 75)

  fs.writeFileSync(auth, JSON.stringify({ ...base, present: false }))
  fs.writeFileSync(selected, JSON.stringify(base))
  run([
    "mobile-project-check",
    "--operation-id", "mobile-deleted",
    "--authoritative", auth,
    "--selected", selected,
  ], 75)

  fs.writeFileSync(auth, JSON.stringify(base))
  fs.writeFileSync(selected, JSON.stringify({ ...base, head_sha: "different" }))
  run([
    "mobile-project-check",
    "--operation-id", "mobile-head",
    "--authoritative", auth,
    "--selected", selected,
  ], 75)

  console.log(JSON.stringify({ status: "passed", checks }, null, 2))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
