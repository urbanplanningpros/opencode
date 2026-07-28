import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dryRunIndex = argv.indexOf("--dry-run")
const dryRun = dryRunIndex !== -1
if (dryRun) argv.splice(dryRunIndex, 1)

const separator = argv.indexOf("--")
const codexArgs = separator === -1 ? argv : argv.slice(separator + 1)

function configOverrides(args) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if ((value === "-c" || value === "--config") && args[index + 1]) {
      values.push(args[index + 1])
      index += 1
      continue
    }
    const match = value.match(/^(?:-c|--config)=(.*)$/s)
    if (match) values.push(match[1])
  }
  return values
}

function attemptsToEnableNativeMemories(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === "--enable" && args[index + 1] === "memories") return true
    if (value === "--enable=memories") return true
  }
  return configOverrides(args).some((value) => /^\s*features\.memories\s*=\s*true\s*$/i.test(value))
}

if (attemptsToEnableNativeMemories(codexArgs)) {
  console.error(
    "Refusing to enable native Codex memories while memory consolidation can receive MultiAgentV2 spawn tools and leak unowned child-thread events. Continue through the provider-neutral task manifest and guarded rehydration path.",
  )
  process.exit(64)
}

const baseLauncher = path.resolve(
  process.env.OPERATOR_CODEX_BASE_LAUNCHER || path.join(scriptDir, "codex-cache-safe-launch.mjs"),
)
const delegatedArgs = [baseLauncher, ...(dryRun ? ["--dry-run"] : []), "--", "--disable", "memories", ...codexArgs]
const delegatedEnv = {
  ...process.env,
  OPERATOR_CODEX_NATIVE_MEMORY_GUARD_ACTIVE: "1",
}

if (dryRun) {
  const result = spawnSync(process.execPath, delegatedArgs, {
    cwd: process.cwd(),
    env: delegatedEnv,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(result.status ?? 69)
  }

  let summary
  try {
    summary = JSON.parse(result.stdout)
  } catch (error) {
    console.error(`Unable to parse the guarded Codex dry-run summary: ${error.message}`)
    process.exit(69)
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        native_memories: false,
        memory_consolidation_multi_agent_guard: true,
        state_continuity: "provider-neutral task manifest plus operator:rehydrate",
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

console.error(
  "Codex native-memory guard active: memories are disabled; durable state must remain in the provider-neutral task manifest and operator rehydration path.",
)

const child = spawn(process.execPath, delegatedArgs, {
  cwd: process.cwd(),
  env: delegatedEnv,
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on("error", (error) => {
  console.error(`Unable to start the guarded Codex launcher: ${error.message}`)
  process.exit(69)
})

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
