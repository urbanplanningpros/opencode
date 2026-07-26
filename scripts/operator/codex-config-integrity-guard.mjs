import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, file)
}

const args = parseArgs(process.argv.slice(2))
const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const configFile = path.join(codexHome, "config.toml")
const stateFile = path.resolve(args.state || path.join(codexHome, "operator-state", "config-integrity.json"))
const requiredNetworkAccess = args["require-network-access"] === "true" || process.env.OPERATOR_REQUIRE_CODEX_NETWORK_ACCESS === "1"
const mode = args.baseline ? "baseline" : args.verify ? "verify" : "audit"

if (!fs.existsSync(configFile)) {
  console.error(`Codex config not found: ${configFile}`)
  process.exit(2)
}

const content = fs.readFileSync(configFile, "utf8")
const networkMatch = content.match(/\[sandbox_workspace_write\][\s\S]*?(?=\n\[|$)/)
const networkEnabled = Boolean(networkMatch?.[0].match(/^\s*network_access\s*=\s*true\s*$/m))
const snapshot = {
  checked_at: new Date().toISOString(),
  config_file: configFile,
  sha256: sha256(content),
  bytes: Buffer.byteLength(content),
  network_access_true: networkEnabled,
}

if (mode === "baseline") {
  atomicWrite(
    stateFile,
    `${JSON.stringify({ ...snapshot, baseline_at: snapshot.checked_at, expected_network_access_true: networkEnabled }, null, 2)}\n`,
  )
  console.log(JSON.stringify({ status: "baseline_created", state_file: stateFile, ...snapshot }, null, 2))
  process.exit(0)
}

const baseline = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null
const changed = baseline ? baseline.sha256 !== snapshot.sha256 : null
const networkDowngraded = Boolean(baseline?.expected_network_access_true && !networkEnabled)
const policyViolation = requiredNetworkAccess && !networkEnabled
const safe = !networkDowngraded && !policyViolation

const result = {
  status: safe ? "ok" : "config_drift_requires_review",
  mode,
  baseline_present: Boolean(baseline),
  changed_since_baseline: changed,
  network_access_downgraded: networkDowngraded,
  required_network_access_missing: policyViolation,
  state_file: stateFile,
  ...snapshot,
  required_actions: safe
    ? []
    : [
        "Do not continue remote-control turns until the host configuration is reviewed locally.",
        "Preserve the current config.toml and operator baseline as evidence before restoring settings.",
        "Restore network_access only from a locally approved configuration, then create a new baseline.",
        "Keep external writes in the idempotent queue and reconcile uncertain operations before replay.",
      ],
}

console.log(JSON.stringify(result, null, 2))
if (!safe) process.exit(2)
