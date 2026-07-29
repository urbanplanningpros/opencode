import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const guard = path.join(here, "codex-terminal-path-provenance-guard.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-terminal-path-guard-"))

function run(name, evidence, expectedStatus) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedStatus) {
    throw new Error(`${name}: expected status ${expectedStatus}, received ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

const healthy = run(
  "healthy",
  {
    host_platform: "linux",
    terminals: [
      {
        item_id: "posix-authority",
        cwd: "/srv/upp/repo",
        purpose: "local_filesystem_authority",
        local_authority_verified: true,
        expected_normalized_uri: "file:///srv/upp/repo",
      },
      {
        item_id: "windows-display",
        cwd: "\\\\?\\D:\\reports\\report.pdf",
        purpose: "display_only",
        expected_normalized_uri: "file:///D:/reports/report.pdf",
      },
      {
        item_id: "unc-display",
        cwd: "\\\\.\\UNC\\server\\share\\reports\\report.pdf",
        purpose: "display_only",
        expected_normalized_uri: "file://server/share/reports/report.pdf",
      },
    ],
  },
  0,
)
if (!healthy.admitted || healthy.findings[1].foreign_to_host !== true) {
  throw new Error("healthy: expected foreign display path to remain admitted without local authority")
}

const foreignAuthority = run(
  "foreign-authority",
  {
    host_platform: "linux",
    terminals: [
      {
        item_id: "windows-authority",
        cwd: "C:\\repo",
        purpose: "local_filesystem_authority",
        local_authority_verified: true,
      },
    ],
  },
  64,
)
if (!foreignAuthority.findings[0].reasons.includes("foreign_path_cannot_grant_local_authority")) {
  throw new Error("foreign-authority: missing foreign path rejection")
}

const opaqueAuthority = run(
  "opaque-authority",
  {
    host_platform: "windows",
    terminals: [
      {
        item_id: "device-authority",
        cwd: "\\\\.\\COM1",
        purpose: "local_filesystem_authority",
        local_authority_verified: true,
      },
    ],
  },
  64,
)
if (opaqueAuthority.findings[0].path_kind !== "opaque") {
  throw new Error("opaque-authority: reserved device namespace must stay opaque")
}

const mismatch = run(
  "mismatch",
  {
    host_platform: "windows",
    terminals: [
      {
        item_id: "namespace-drive",
        cwd: "\\\\?\\D:\\reports",
        purpose: "display_only",
        expected_normalized_uri: "file:///C:/wrong",
      },
    ],
  },
  64,
)
if (!mismatch.findings[0].reasons.includes("normalized_uri_mismatch")) {
  throw new Error("mismatch: expected canonical URI mismatch rejection")
}

fs.rmSync(root, { recursive: true, force: true })
console.log("codex terminal path provenance guard self-test passed")
