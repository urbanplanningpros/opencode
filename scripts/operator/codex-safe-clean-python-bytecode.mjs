#!/usr/bin/env node

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"

const ALLOWED_EXTENSIONS = new Set([".pyc", ".pyo"])
const MANIFEST_VERSION = 1

function usage() {
  console.error(`Usage:
  Dry run:
    node scripts/operator/codex-safe-clean-python-bytecode.mjs [--root PATH] [--json]

  Execute a previously reviewed manifest:
    node scripts/operator/codex-safe-clean-python-bytecode.mjs \
      --execute --manifest PATH --confirm TOKEN [--json]

The dry run never deletes files. It writes a manifest beneath
<root>/.operator/cleanup-manifests and returns the exact confirmation token
required for execution.`)
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    execute: false,
    manifest: null,
    confirm: null,
    json: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root") args.root = argv[++index]
    else if (arg === "--execute") args.execute = true
    else if (arg === "--manifest") args.manifest = argv[++index]
    else if (arg === "--confirm") args.confirm = argv[++index]
    else if (arg === "--json") args.json = true
    else if (arg === "--help" || arg === "-h") {
      usage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!args.root) throw new Error("--root requires a path")
  if (args.execute && (!args.manifest || !args.confirm)) {
    throw new Error("--execute requires both --manifest and --confirm")
  }
  if (!args.execute && (args.manifest || args.confirm)) {
    throw new Error("--manifest and --confirm are valid only with --execute")
  }
  return args
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

function hasGitSegment(relativePath) {
  return relativePath.split(/[\\/]+/u).some((part) => part.toLowerCase() === ".git")
}

function normalizeRelativePath(value) {
  return value.split(sep).join("/")
}

async function enumerateCandidates(root) {
  const candidates = []

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".git") continue
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      if (!ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

      const canonical = await realpath(absolutePath)
      if (!isInside(root, canonical)) {
        throw new Error(`Candidate escapes root: ${absolutePath}`)
      }
      const rel = normalizeRelativePath(relative(root, canonical))
      if (hasGitSegment(rel)) {
        throw new Error(`Candidate is inside .git: ${rel}`)
      }
      const metadata = await stat(canonical)
      candidates.push({
        path: rel,
        size: metadata.size,
        mtime_ms: Math.trunc(metadata.mtimeMs),
      })
    }
  }

  await walk(root)
  candidates.sort((a, b) => a.path.localeCompare(b.path))
  return candidates
}

function readTrackedFiles(root) {
  const topLevel = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (topLevel.error?.code === "ENOENT") {
    throw new Error("git is required to validate tracked files")
  }
  if (topLevel.status !== 0) {
    throw new Error("Cleanup root must be the root of a Git worktree")
  }

  const gitRoot = realpathSync(topLevel.stdout.trim())
  if (gitRoot !== root) {
    throw new Error(`Cleanup root must equal the Git worktree root: ${gitRoot}`)
  }

  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`Unable to read tracked files: ${result.stderr.trim() || "git ls-files failed"}`)
  }

  return new Set(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((item) => item.replaceAll("\\", "/")),
  )
}

function snapshotHash(root, candidates) {
  return sha256(
    JSON.stringify({
      version: MANIFEST_VERSION,
      root,
      candidates,
    }),
  )
}

async function writeManifest(root, candidates, blockedTracked) {
  const snapshot_sha256 = snapshotHash(root, candidates)
  const manifest = {
    version: MANIFEST_VERSION,
    operation: "delete-python-bytecode",
    root,
    created_at_utc: new Date().toISOString(),
    snapshot_sha256,
    confirmation_token: `DELETE_PYTHON_BYTECODE:${snapshot_sha256}`,
    candidate_count: candidates.length,
    blocked_tracked_paths: blockedTracked,
    candidates,
  }

  const manifestDirectory = join(root, ".operator", "cleanup-manifests")
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 })
  const manifestPath = join(manifestDirectory, `python-bytecode-${snapshot_sha256}.json`)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error
    const existing = JSON.parse(await readFile(manifestPath, "utf8"))
    if (existing.snapshot_sha256 !== snapshot_sha256) throw error
  })

  return { manifest, manifestPath }
}

async function loadManifest(path) {
  const canonicalPath = await realpath(resolve(path))
  const parsed = JSON.parse(await readFile(canonicalPath, "utf8"))
  if (parsed.version !== MANIFEST_VERSION || parsed.operation !== "delete-python-bytecode") {
    throw new Error("Unsupported cleanup manifest")
  }
  if (!isAbsolute(parsed.root)) throw new Error("Manifest root must be absolute")
  if (!Array.isArray(parsed.candidates)) throw new Error("Manifest candidates are invalid")
  return { manifest: parsed, manifestPath: canonicalPath }
}

async function verifyManifest(manifest, confirmation) {
  const root = await realpath(manifest.root)
  if (root !== manifest.root) throw new Error("Manifest root no longer resolves to the same path")
  if (confirmation !== manifest.confirmation_token) throw new Error("Confirmation token does not match manifest")

  const currentCandidates = await enumerateCandidates(root)
  const currentHash = snapshotHash(root, currentCandidates)
  if (currentHash !== manifest.snapshot_sha256) {
    throw new Error("Cleanup target set changed after review; create a new dry-run manifest")
  }

  const trackedFiles = readTrackedFiles(root)
  const blockedTracked = currentCandidates.map((item) => item.path).filter((item) => trackedFiles.has(item))
  if (blockedTracked.length > 0) {
    throw new Error(`Refusing to delete Git-tracked bytecode files: ${blockedTracked.join(", ")}`)
  }

  return { root, currentCandidates }
}

async function executeCleanup(manifest, confirmation) {
  if (manifest.blocked_tracked_paths?.length > 0) {
    throw new Error("Manifest contains Git-tracked candidates and cannot be executed")
  }

  const { root, currentCandidates } = await verifyManifest(manifest, confirmation)
  const deleted = []

  for (const item of currentCandidates) {
    if (!ALLOWED_EXTENSIONS.has(extname(item.path).toLowerCase())) {
      throw new Error(`Manifest contains a disallowed extension: ${item.path}`)
    }
    if (hasGitSegment(item.path)) throw new Error(`Manifest contains a .git path: ${item.path}`)

    const absolutePath = resolve(root, item.path)
    if (!isInside(root, absolutePath)) throw new Error(`Manifest path escapes root: ${item.path}`)

    const metadata = await lstat(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Candidate is no longer a regular file: ${item.path}`)
    }
    if (metadata.size !== item.size || Math.trunc(metadata.mtimeMs) !== item.mtime_ms) {
      throw new Error(`Candidate changed after validation: ${item.path}`)
    }

    await unlink(absolutePath)
    deleted.push(item.path)
  }

  return { root, deleted }
}

function emit(args, payload, humanLines = []) {
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else for (const line of humanLines) console.log(line)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.execute) {
    const { manifest, manifestPath } = await loadManifest(args.manifest)
    const result = await executeCleanup(manifest, args.confirm)
    emit(
      args,
      {
        status: "completed",
        manifest_path: manifestPath,
        root: result.root,
        deleted_count: result.deleted.length,
        deleted_paths: result.deleted,
      },
      [`Deleted ${result.deleted.length} validated Python bytecode file(s).`, `Manifest: ${manifestPath}`],
    )
    return
  }

  const root = await realpath(resolve(args.root))
  const rootMetadata = await stat(root)
  if (!rootMetadata.isDirectory()) throw new Error("Root must be a directory")

  const candidates = await enumerateCandidates(root)
  const trackedFiles = readTrackedFiles(root)
  const blockedTracked = candidates.map((item) => item.path).filter((item) => trackedFiles.has(item))
  const { manifest, manifestPath } = await writeManifest(root, candidates, blockedTracked)
  const status = blockedTracked.length > 0 ? "blocked" : "dry_run_complete"

  emit(
    args,
    {
      status,
      root,
      manifest_path: manifestPath,
      candidate_count: candidates.length,
      blocked_tracked_paths: blockedTracked,
      representative_paths: candidates.slice(0, 20).map((item) => item.path),
      confirmation_token: blockedTracked.length === 0 ? manifest.confirmation_token : null,
      execute_command:
        blockedTracked.length === 0
          ? `node ${process.argv[1]} --execute --manifest ${JSON.stringify(manifestPath)} --confirm ${JSON.stringify(manifest.confirmation_token)}`
          : null,
    },
    blockedTracked.length > 0
      ? [
          `Blocked: ${blockedTracked.length} candidate(s) are Git-tracked.`,
          ...blockedTracked.slice(0, 20).map((item) => `  ${item}`),
        ]
      : [
          `Dry run found ${candidates.length} untracked Python bytecode file(s).`,
          `Manifest: ${manifestPath}`,
          `Confirmation token: ${manifest.confirmation_token}`,
          "No files were deleted.",
        ],
  )

  if (blockedTracked.length > 0) process.exitCode = 2
}

main().catch((error) => {
  console.error(`safe-python-bytecode-clean: ${error.message}`)
  process.exitCode = 2
})
