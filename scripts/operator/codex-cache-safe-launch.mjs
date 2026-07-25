import { spawn } from "node:child_process"

const argv = process.argv.slice(2)
const dryRunIndex = argv.indexOf("--dry-run")
const dryRun = dryRunIndex !== -1
if (dryRun) argv.splice(dryRunIndex, 1)
const separator = argv.indexOf("--")
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)
const joined = codexArgs.join(" ")

if (
  /--enable(?:=|\s+)remote_plugin(?:\s|$)/i.test(joined) ||
  /(?:-c|--config)(?:=|\s+)features\.remote_plugin\s*=\s*true/i.test(joined)
) {
  console.error("Refusing to re-enable remote_plugin while the Codex cache write-amplification guard is active.")
  process.exit(64)
}

const binary = process.env.OPERATOR_CODEX_BINARY || process.env.CODEX_BINARY || "codex"
const guardedArgs = ["--disable", "remote_plugin", ...codexArgs]
const summary = {
  binary,
  args: guardedArgs,
  codex_home: process.env.CODEX_HOME || null,
  remote_plugin: false,
}

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.error("Codex cache guard active: remote_plugin is disabled for this process. Local and installed tooling remain available.")
const child = spawn(binary, guardedArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_CACHE_GUARD_ACTIVE: "1",
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
