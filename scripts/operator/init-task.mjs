import fs from "node:fs"
import path from "node:path"
import { nowIso, parseArgs, randomId, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
if (!args.objective) {
  console.error("Usage: bun operator:init --objective \"...\" [--acceptance \"a|b\"] [--risk read_only|low|medium|high|irreversible] [--write]")
  process.exit(2)
}

const taskId = args["task-id"] || randomId("task")
const operationId = args["operation-id"] || randomId("op")
const writeIntent = Boolean(args.write)
const idempotencyKey = args["idempotency-key"] || (writeIntent ? randomId("idem") : null)
const root = stateRoot(args)
const taskDir = path.join(root, "tasks", taskId)
const manifest = {
  task_id: taskId,
  operation_id: operationId,
  idempotency_key: idempotencyKey,
  objective: args.objective,
  acceptance_criteria: String(args.acceptance || "Complete the objective and provide verification evidence")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean),
  risk: args.risk || (writeIntent ? "medium" : "read_only"),
  write_intent: writeIntent,
  handoff_safe: args["handoff-safe"] === "false" ? false : true,
  allowed_paths: String(args["allowed-paths"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  prohibited_actions: [
    "access production secrets",
    "deploy directly to production",
    "disable tests or approval gates",
    "modify agent instructions unless explicitly approved",
  ],
  source_refs: [],
  created_at: nowIso(),
}

fs.mkdirSync(taskDir, { recursive: true })
writeJsonAtomic(path.join(taskDir, "manifest.json"), manifest)
writeJsonAtomic(path.join(taskDir, "current-state.json"), {
  task_id: taskId,
  status: "queued",
  active_provider: null,
  attempts: [],
  updated_at: nowIso(),
})
fs.writeFileSync(path.join(taskDir, "objective.md"), `# Objective\n\n${manifest.objective}\n`)
fs.writeFileSync(
  path.join(taskDir, "acceptance-criteria.md"),
  `# Acceptance criteria\n\n${manifest.acceptance_criteria.map((item) => `- [ ] ${item}`).join("\n")}\n`,
)
fs.writeFileSync(path.join(taskDir, "decisions.json"), "[]\n")
fs.writeFileSync(path.join(taskDir, "changed-files.json"), "[]\n")
fs.writeFileSync(path.join(taskDir, "continuation-prompt.md"), "# Continuation prompt\n\nNo provider has started this task.\n")

console.log(path.join(taskDir, "manifest.json"))
