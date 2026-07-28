#!/usr/bin/env node

import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
const separator = argv.indexOf("--")
const launcherArgs = separator === -1 ? [] : argv.slice(0, separator)
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)
const joined = codexArgs.join(" ")

const goalEnableFlag = /--enable(?:=|\s+)goals(?:\s|$)/i
const goalConfigFlag = /(?:-c|--config)(?:=|\s+)features\.goals\s*=\s*true/i

if (goalEnableFlag.test(joined) || goalConfigFlag.test(joined)) {
  console.error(
    "Refusing to enable Codex Goals while unattended goal continuation can convert assistant recommendations into implementation work without a new authoritative user message.",
  )
  process.exit(64)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const guardedLauncher = path.join(scriptDir, "codex-cache-safe-launch.mjs")
const bunBinary = process.env.OPERATOR_BUN_BINARY || "bun"
const childArgs = [guardedLauncher, ...launcherArgs, "--", "--disable", "goals", ...codexArgs]

const child = spawn(bunBinary, childArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_GOAL_AUTHORITY_GUARD_ACTIVE: "1",
  },
  stdio: "inherit",
  shell: false,
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on("error", (error) => {
  console.error(`Unable to start the Goal-authority guarded Codex launcher: ${error.message}`)
  process.exit(69)
})

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Goal-authority guarded Codex terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
