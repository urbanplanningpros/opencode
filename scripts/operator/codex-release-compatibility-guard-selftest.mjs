import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-compatibility-"))
const guard = path.join(process.cwd(), "scripts/operator/codex-release-compatibility-guard.mjs")
const hash = "a".repeat(64)

function run(name, evidence, expectedStatus, expectedResult) {
  const input = path.join(root, `${name}.json`)
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`)
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], { encoding: "utf8" })
  if (result.status !== expectedStatus) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${name}: expected exit ${expectedStatus}, received ${result.status}`)
  }
  const output = JSON.parse(result.stdout)
  if (output.status !== expectedResult) throw new Error(`${name}: expected ${expectedResult}, received ${output.status}`)
  return output
}

const base = {
  app_server_version: "0.146.0",
  exec_server_version: "0.145.0",
  routing: { provider: "openai", route: "direct", automatic_selector: false, model_gateway: false },
  mcp: {
    transport: "http",
    configured_server_name: "approved-crm",
    discovered_server_name: "approved-crm",
    approved_tool_catalog_sha256: hash,
    observed_tool_catalog_sha256: hash,
    write_authority_requested: true,
    oauth: { status: "ok", retry_count: 0 },
  },
}

try {
  run("healthy", base, 0, "compatible")

  const legacy = structuredClone(base)
  legacy.exec_server_version = "0.144.4"
  const legacyResult = run("legacy", legacy, 75, "remediation_required")
  if (!legacyResult.remediation.some((item) => item.includes("exec_server_version_below"))) {
    throw new Error("legacy: missing version-floor remediation")
  }

  const missingIdentity = structuredClone(base)
  missingIdentity.mcp.discovered_server_name = null
  const missingResult = run("missing-identity", missingIdentity, 0, "compatible")
  if (!missingResult.warnings.includes("mcp_server_identity_missing_using_configured_name")) {
    throw new Error("missing-identity: warning was not emitted")
  }

  const drift = structuredClone(base)
  drift.mcp.observed_tool_catalog_sha256 = "b".repeat(64)
  const driftResult = run("catalog-drift", drift, 64, "blocked")
  if (!driftResult.blocked.includes("mcp_tool_catalog_drift")) throw new Error("catalog-drift: drift was not blocked")

  const transient = structuredClone(base)
  transient.mcp.oauth = { status: "transient_http", retry_count: 0 }
  run("transient", transient, 75, "remediation_required")

  const anonymous = structuredClone(transient)
  anonymous.mcp.oauth.anonymous_fallback_requested = true
  const anonymousResult = run("anonymous", anonymous, 64, "blocked")
  if (!anonymousResult.blocked.includes("oauth_anonymous_fallback_requested")) {
    throw new Error("anonymous: unsafe fallback was not blocked")
  }

  const prohibited = structuredClone(base)
  prohibited.routing = { provider: "anthropic", route: "gateway", automatic_selector: true }
  run("prohibited", prohibited, 64, "blocked")

  console.log("Codex release compatibility guard self-test passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
