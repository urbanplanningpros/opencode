import { spawn } from "node:child_process"

const argv = process.argv.slice(2)
const dryRunIndex = argv.indexOf("--dry-run")
const dryRun = dryRunIndex !== -1
if (dryRun) argv.splice(dryRunIndex, 1)
const separator = argv.indexOf("--")
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)
const joined = codexArgs.join(" ")

const prohibitedFeatureOverrides = [
  { feature: "remote_plugin", reason: "Codex cache write-amplification guard" },
  { feature: "code_mode", reason: "Code Mode metadata-header guard" },
  { feature: "code_mode_only", reason: "Code Mode metadata-header guard" },
]

for (const item of prohibitedFeatureOverrides) {
  const enableFlag = new RegExp(`--enable(?:=|\\s+)${item.feature}(?:\\s|$)`, "i")
  const configFlag = new RegExp(`(?:-c|--config)(?:=|\\s+)features\\.${item.feature}\\s*=\\s*true`, "i")
  if (enableFlag.test(joined) || configFlag.test(joined)) {
    console.error(`Refusing to enable ${item.feature} while the ${item.reason} is active.`)
    process.exit(64)
  }
}

const binary = process.env.OPERATOR_CODEX_BINARY || process.env.CODEX_BINARY || "codex"
const guardedArgs = [
  "--disable",
  "remote_plugin",
  "--disable",
  "code_mode",
  "--disable",
  "code_mode_only",
  ...codexArgs,
]
const summary = {
  binary,
  args: guardedArgs,
  codex_home: process.env.CODEX_HOME || null,
  remote_plugin: false,
  code_mode: false,
  code_mode_only: false,
}

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.error(
  "Codex guards active: remote_plugin, code_mode, and code_mode_only are disabled for this process. Local and installed tooling remain available.",
)
const child = spawn(binary, guardedArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_CACHE_GUARD_ACTIVE: "1",
    CODEX_CODE_MODE_GUARD_ACTIVE: "1",
  },
  stdio: "inherit",
  shell: false,
})

child.on("error", (error) => {
  console.error(`Unable to start guarded Codex CLI: ${error.message}`)
  process.exit(69)
})
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Guarded Codex CLI terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
