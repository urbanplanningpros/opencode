import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagent-permission-"))
const guard = process.env.GUARD_PATH || path.join(process.cwd(), "codex-subagent-permission-preflight.mjs")
let fixtures = 0

function writeManifest(name, mutate = () => {}) {
  const parentA = path.join(root, "parent-a")
  const parentB = path.join(root, "parent-b")
  fs.mkdirSync(parentA, { recursive: true })
  fs.mkdirSync(parentB, { recursive: true })
  const manifest = {
    operation_id: `operation-${name}`,
    parent_thread_id: "parent-thread-1",
    task_name: `task-${name}`,
    environment_id: "local-test",
    route: {
      provider: "openai",
      model: "gpt-5.6-sol",
      automatic_model_selection: false,
      gateway: null,
      fallbacks: [],
    },
    parent: {
      write_roots: [parentA, parentB],
      network: true,
      tools: ["apply_patch", "shell", "github:read"],
    },
    child: {
      write_roots: [parentA],
      network: false,
      tools: ["shell"],
    },
  }
  mutate(manifest, { parentA, parentB })
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return { file, manifest, parentA, parentB }
}

function run(args, expectedStatus) {
  const result = spawnSync(process.execPath, [guard, ...args], { encoding: "utf8" })
  if (result.status !== expectedStatus) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`Expected exit ${expectedStatus}, received ${result.status}`)
  }
  fixtures += 1
  const output = (expectedStatus === 0 ? result.stdout : result.stderr).trim()
  return JSON.parse(output)
}

try {
  const healthy = writeManifest("healthy")
  const receipt = path.join(root, "healthy-receipt.json")
  const state = path.join(root, "state.json")
  run(["--prepare", "--manifest", healthy.file, "--receipt", receipt, "--state", state], 0)
  run(["--consume", "--manifest", healthy.file, "--receipt", receipt, "--state", state], 0)
  run(["--consume", "--manifest", healthy.file, "--receipt", receipt, "--state", state], 2)

  const outside = path.join(root, "outside")
  fs.mkdirSync(outside)
  const rootExpansion = writeManifest("root-expansion", (manifest) => {
    manifest.child.write_roots = [outside]
  })
  run(["--prepare", "--manifest", rootExpansion.file, "--receipt", path.join(root, "root-expansion-receipt.json")], 2)

  const networkExpansion = writeManifest("network-expansion", (manifest) => {
    manifest.parent.network = false
    manifest.child.network = true
  })
  run(["--prepare", "--manifest", networkExpansion.file, "--receipt", path.join(root, "network-receipt.json")], 2)

  const toolExpansion = writeManifest("tool-expansion", (manifest) => {
    manifest.child.tools.push("github:write")
  })
  run(["--prepare", "--manifest", toolExpansion.file, "--receipt", path.join(root, "tool-receipt.json")], 2)

  const gateway = writeManifest("gateway", (manifest) => {
    manifest.route.gateway = "automatic-router"
  })
  run(["--prepare", "--manifest", gateway.file, "--receipt", path.join(root, "gateway-receipt.json")], 2)

  const automatic = writeManifest("automatic", (manifest) => {
    manifest.route.automatic_model_selection = true
  })
  run(["--prepare", "--manifest", automatic.file, "--receipt", path.join(root, "automatic-receipt.json")], 2)

  const prohibited = writeManifest("prohibited", (manifest) => {
    manifest.route.provider = "anthropic"
    manifest.route.model = "claude"
  })
  run(["--prepare", "--manifest", prohibited.file, "--receipt", path.join(root, "prohibited-receipt.json")], 2)

  const localUnauthorized = writeManifest("local-unauthorized", (manifest) => {
    manifest.route.provider = "local"
    manifest.route.model = "approved-local-model"
  })
  run(["--prepare", "--manifest", localUnauthorized.file, "--receipt", path.join(root, "local-unapproved.json")], 2)

  const localAuthorized = writeManifest("local-authorized", (manifest) => {
    manifest.route.provider = "local"
    manifest.route.model = "approved-local-model"
    manifest.route.authorized_local = true
  })
  run(["--prepare", "--manifest", localAuthorized.file, "--receipt", path.join(root, "local-approved.json")], 0)

  if (process.platform !== "win32") {
    const symbolic = writeManifest("symbolic")
    const target = path.join(symbolic.parentA, "target")
    const link = path.join(symbolic.parentA, "link")
    fs.mkdirSync(target)
    fs.symlinkSync(target, link)
    symbolic.manifest.child.write_roots = [link]
    fs.writeFileSync(symbolic.file, `${JSON.stringify(symbolic.manifest, null, 2)}\n`)
    run(["--prepare", "--manifest", symbolic.file, "--receipt", path.join(root, "symbolic-receipt.json")], 2)
  }

  const drift = writeManifest("identity-drift", (manifest, paths) => {
    const child = path.join(paths.parentA, "child")
    fs.mkdirSync(child)
    manifest.child.write_roots = [child]
  })
  const driftReceipt = path.join(root, "drift-receipt.json")
  run(["--prepare", "--manifest", drift.file, "--receipt", driftReceipt], 0)
  const childPath = drift.manifest.child.write_roots[0]
  fs.rmSync(childPath, { recursive: true, force: true })
  fs.mkdirSync(childPath)
  run(["--consume", "--manifest", drift.file, "--receipt", driftReceipt], 2)

  console.log(`Codex subagent permission preflight self-test passed (${fixtures} fixtures)`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
