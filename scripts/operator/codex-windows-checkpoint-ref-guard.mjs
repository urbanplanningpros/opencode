import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    shell: false,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "git command failed").trim()
    throw new Error(detail)
  }
  return String(result.stdout || "").trim()
}

const args = parseArgs(process.argv.slice(2))
const repo = path.resolve(String(args.repo || process.cwd()))
const threshold = Number.parseInt(String(args["max-path-chars"] || process.env.OPERATOR_CODEX_WINDOWS_REF_MAX_CHARS || "240"), 10)

if (!Number.isInteger(threshold) || threshold < 128 || threshold > 4096) {
  console.error("--max-path-chars must be an integer from 128 through 4096")
  process.exit(2)
}

let gitDir
let refs
try {
  gitDir = git(repo, ["rev-parse", "--absolute-git-dir"])
  refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/codex/turn-diffs/checkpoints/"])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
} catch (error) {
  console.error(`Unable to inspect repository checkpoint refs: ${error.message}`)
  process.exit(2)
}

const gitDirStat = fs.lstatSync(gitDir)
if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
  console.error(`Refusing unsafe Git directory: ${gitDir}`)
  process.exit(64)
}

const inspected = refs.map((refname) => {
  const loosePath = path.join(gitDir, ...refname.split("/"))
  let loose = false
  let symlink = false
  try {
    const stat = fs.lstatSync(loosePath)
    loose = stat.isFile()
    symlink = stat.isSymbolicLink()
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  return {
    refname,
    refname_chars: refname.length,
    loose,
    loose_path: loosePath,
    loose_path_chars: loosePath.length,
    symlink,
    exceeds_threshold: loose && loosePath.length >= threshold,
  }
})

if (inspected.some((item) => item.symlink)) {
  console.error(JSON.stringify({
    admitted: false,
    reason: "symlinked_checkpoint_ref",
    repository: repo,
    git_dir: gitDir,
    refs: inspected,
  }, null, 2))
  process.exit(64)
}

const affected = inspected.filter((item) => item.exceeds_threshold)
const report = {
  admitted: affected.length === 0,
  repository: repo,
  git_dir: gitDir,
  max_path_chars: threshold,
  checkpoint_ref_count: inspected.length,
  affected_loose_ref_count: affected.length,
  affected_refs: affected,
  remediation: affected.length === 0
    ? null
    : {
        preconditions: [
          "Stop Codex Desktop and other Git writers for this repository.",
          "Back up .git/packed-refs when present and the refs/codex/turn-diffs/checkpoints tree.",
          "Confirm git fsck --no-reflogs reports no repository corruption before maintenance.",
        ],
        command: "git pack-refs --all --prune",
        verification: [
          "Run this guard again and require affected_loose_ref_count=0.",
          "Run git fsck --no-reflogs again.",
          "Open the Git client and verify branches and labels load normally.",
        ],
      },
}

console.log(JSON.stringify(report, null, 2))
process.exit(affected.length === 0 ? 0 : 75)
