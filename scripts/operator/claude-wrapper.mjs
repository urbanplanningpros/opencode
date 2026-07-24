import fs from "node:fs"
import { spawn } from "node:child_process"

const model = process.env.OPERATOR_MODEL
if (!model) {
  console.error("OPERATOR_MODEL is required")
  process.exit(64)
}

let policy
try {
  policy = JSON.parse(process.env.OPERATOR_MODEL_POLICY || "{}")
} catch (error) {
  console.error(`OPERATOR_MODEL_POLICY must be valid JSON: ${error.message}`)
  process.exit(64)
}

if (/manus/i.test(model)) {
  console.error("Manus routes are prohibited")
  process.exit(64)
}

if (model === "claude-opus-5") {
  if (process.env.OPERATOR_MODEL_LANE !== "candidate") {
    console.error("claude-opus-5 is restricted to the candidate lane")
    process.exit(64)
  }
  if (
    policy.thinking !== "adaptive_default" ||
    policy.disableThinkingMaxEffort !== "high" ||
    policy.serverSideFallback !== "disabled" ||
    policy.midConversationToolChanges !== "disabled"
  ) {
    console.error("claude-opus-5 request policy is incompatible with the approved canary")
    process.exit(64)
  }
}

let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
if (Buffer.byteLength(prompt, "utf8") > 10 * 1024 * 1024) {
  console.error("Operator prompt exceeds Claude Code's 10MB piped-input limit")
  process.exit(64)
}

const args = ["-p", "--model", model, "--output-format", "text", "--no-session-persistence"]
if (process.env.OPERATOR_MODEL_LANE === "candidate") {
  args.unshift("--bare")
  args.push("--permission-mode", "plan")
  const policyFile = process.env.OPERATOR_POLICY_FILE || "AGENTS.md"
  if (fs.existsSync(policyFile)) args.push("--append-system-prompt-file", policyFile)
}

const child = spawn(process.env.OPERATOR_CLAUDE_BINARY || "claude", args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "inherit", "inherit"],
  shell: false,
})

child.on("error", (error) => {
  console.error(`Unable to start Claude Code: ${error.message}`)
  process.exit(69)
})
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Claude Code terminated by ${signal}`)
    process.exit(69)
  }
  process.exit(code ?? 69)
})
child.stdin.end(prompt)
