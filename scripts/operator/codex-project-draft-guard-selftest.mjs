import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./codex-project-draft-guard.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-draft-"))
const projectA = path.join(root, "project-a")
const projectB = path.join(root, "project-b")
fs.mkdirSync(projectA)
fs.mkdirSync(projectB)
const inputA = path.join(root, "a.txt")
const inputB = path.join(root, "b.txt")
fs.writeFileSync(inputA, "Deploy only repository A after its immutable review snapshot passes.\n")
fs.writeFileSync(inputB, "Run a read-only connector audit for repository B.\n")

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
  if (result.status !== expected) {
    throw new Error(`expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout || result.stderr)
}

try {
  const a = run(["--project-root", projectA, "--write", inputA])
  const b = run(["--project-root", projectB, "--write", inputB])
  if (a.project_root_sha256 === b.project_root_sha256) throw new Error("project identities were not isolated")
  if (a.draft_sha256 === b.draft_sha256) throw new Error("draft hashes unexpectedly match")

  const verifiedA = run(["--project-root", projectA])
  const verifiedB = run(["--project-root", projectB])
  if (!verifiedA.safe_to_paste_into_matching_project || !verifiedB.safe_to_paste_into_matching_project) {
    throw new Error("valid drafts did not verify")
  }

  const draftDirA = path.join(projectA, ".operator", "codex-drafts")
  const draftDirB = path.join(projectB, ".operator", "codex-drafts")
  fs.copyFileSync(path.join(draftDirA, "new-conversation.md"), path.join(draftDirB, "new-conversation.md"))
  fs.copyFileSync(path.join(draftDirA, "new-conversation.json"), path.join(draftDirB, "new-conversation.json"))
  const mismatch = run(["--project-root", projectB], 2)
  if (!mismatch.reasons.includes("project_identity_mismatch")) throw new Error("cross-project copy was not rejected")

  fs.writeFileSync(path.join(draftDirA, "new-conversation.md"), "tampered\n")
  const tampered = run(["--project-root", projectA], 2)
  if (!tampered.reasons.includes("draft_hash_mismatch")) throw new Error("draft tampering was not rejected")

  console.log("codex project draft guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
