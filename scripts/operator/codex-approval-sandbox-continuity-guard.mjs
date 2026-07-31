import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROHIBITED_ROUTE_TERMS = [
  "anthropic",
  "claude",
  "manus",
  "bedrock",
  "vertex",
  "copilot",
]

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function blocked(message, details = {}) {
  const error = new Error(message)
  error.details = details
  throw error
}

function requireString(value, field) {
  const normalized = String(value || "").trim()
  if (!normalized) blocked(`Missing required field: ${field}`)
  return normalized
}

function requireBoolean(value, field) {
  if (value !== true && value !== false) blocked(`${field} must be boolean`)
  return value
}

function uniqueStrings(value, field) {
  if (!Array.isArray(value)) blocked(`${field} must be an array`)
  const items = [...new Set(value.map((item) => String(item).trim()))]
  if (items.some((item) => !item)) blocked(`${field} contains an empty value`)
  return items
}

function routeText(route) {
  return JSON.stringify(route || {}).toLowerCase().replaceAll(" ", "")
}

function validateRoute(route) {
  const provider = requireString(route?.provider, "route.provider").toLowerCase()
  const runtime = requireString(route?.model || route?.runtime, "route.model_or_runtime")
  const approvedProviders = new Set(
    String(process.env.OPERATOR_APPROVED_PROVIDERS || "openai,local")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )

  if (!approvedProviders.has(provider)) blocked("Execution provider is not approved", { provider })
  if (provider === "local" && route?.authorized_local !== true) {
    blocked("Local continuity route requires explicit authorization")
  }
  if (route?.automatic_model_selection !== false) {
    blocked("Automatic model selection must be explicitly disabled")
  }
  if (route?.gateway) blocked("Model gateways are prohibited", { gateway: route.gateway })
  if (Array.isArray(route?.fallbacks) && route.fallbacks.length > 0) {
    blocked("Automatic fallback chains are prohibited")
  }

  const text = routeText(route)
  const prohibited = PROHIBITED_ROUTE_TERMS.find((term) => text.includes(term))
  if (prohibited) blocked("Route contains a prohibited provider or selector", { prohibited })

  return {
    provider,
    model_or_runtime: runtime,
    authorized_local: route?.authorized_local === true,
    automatic_model_selection: false,
  }
}

function validateCommon(event) {
  const operationId = requireString(event.operation_id, "operation_id")
  const route = validateRoute(event.route)
  requireBoolean(event.state_reconciled, "state_reconciled")
  requireBoolean(event.external_writes_reconciled, "external_writes_reconciled")
  if (!event.state_reconciled || !event.external_writes_reconciled) {
    blocked("State and external writes must be reconciled before continuity routing")
  }

  const forbiddenActions = uniqueStrings(event.requested_actions || [], "requested_actions")
  const forbidden = forbiddenActions.find((action) =>
    [
      "broad-host-restart",
      "delete-state-database",
      "edit-state-database",
      "replay-entire-task",
      "unsandboxed-execution",
      "disable-sandbox",
      "broaden-acls",
      "kill-by-process-name",
    ].includes(action),
  )
  if (forbidden) blocked("Unsafe recovery action requested", { action: forbidden })

  return { operationId, route }
}

function approvalDeadlockPlan(event, common) {
  const threadId = requireString(event.thread_id, "thread_id")
  const taskId = requireString(event.task_id, "task_id")
  const requestId = requireString(event.pending_approval_request_id, "pending_approval_request_id")
  const status = requireString(event.task_status, "task_status")
  const latestType = requireString(event.latest_item?.type, "latest_item.type")
  const latestStatus = requireString(event.latest_item?.status, "latest_item.status")

  if (status !== "waitingOnApproval") blocked("Approval-deadlock guard requires waitingOnApproval status", { status })
  if (latestType !== "fileChange" || latestStatus !== "inProgress") {
    blocked("Approval-deadlock signature does not match an in-progress fileChange item")
  }
  if (event.persisted_terminal_approval_response === true) {
    blocked("A terminal approval response already exists; reconcile it instead of creating a fallback")
  }
  if (event.pending_request_age_seconds !== undefined && Number(event.pending_request_age_seconds) < 30) {
    blocked("Pending approval is too new to classify as stranded")
  }

  const writeRoots = uniqueStrings(event.continuity?.write_roots, "continuity.write_roots")
  const allowedFiles = uniqueStrings(event.continuity?.allowed_files, "continuity.allowed_files")
  if (writeRoots.length === 0 || allowedFiles.length === 0) {
    blocked("Bounded continuity requires explicit write roots and allowed files")
  }
  if (event.continuity?.sandbox_mode !== "workspace-write") {
    blocked("Approval fallback must remain inside workspace-write sandbox")
  }
  if (event.continuity?.approval_policy !== "never") {
    blocked("Fallback must avoid the broken interactive approval surface by using approval_policy=never")
  }
  if (event.continuity?.network_access === true) {
    blocked("Approval-deadlock fallback must not add network authority")
  }
  if (event.continuity?.preauthorized_bounded_mutation !== true) {
    blocked("Bounded mutation must already be authorized by the parent operation")
  }

  return {
    status: "contained-continuity-approved",
    incident: "approval_deadlock",
    operation_id: common.operationId,
    affected_scope: { thread_id: threadId, task_id: taskId, pending_approval_request_id: requestId },
    quarantine: [
      "Block new mutations in the stranded Desktop task only",
      "Do not create another approval request in that task",
      "Preserve the pending request and rollout as evidence",
    ],
    continuity: {
      route: common.route,
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      network_access: false,
      write_roots: writeRoots,
      allowed_files: allowedFiles,
      instructions: [
        "Re-read repository HEAD, dirty state, and target-file hashes before editing",
        "Skip any mutation already present in the reconciled worktree",
        "Perform only the unfinished bounded file changes",
        "Run bounded validation and emit a terminal operation receipt",
        "Attach the receipt to the original operation ledger without replaying the parent turn",
      ],
    },
    resume_condition: [
      "A corrected build can submit Allow/Decline and receives a terminal approval response",
      "Restart/resume rehydrates or cancels orphaned approvals",
      "A disposable fileChange canary completes without leaving waitingOnApproval",
    ],
  }
}

function windowsSpawnChildPlan(event, common) {
  const errorCode = Number(event.error_code)
  const stage = requireString(event.failure_stage, "failure_stage")
  if (errorCode !== 2 || stage !== "SpawnChild") {
    blocked("Windows sandbox signature must be CreateProcessAsUserW error 2 during SpawnChild", {
      error_code: event.error_code,
      failure_stage: stage,
    })
  }
  if (event.helper_resolution_verified !== true || event.resources_verified !== true) {
    blocked("Helper and codex-resources resolution must be verified before classifying this failure")
  }
  if (event.sandbox_canary_failed !== true) blocked("A harmless sandbox canary must reproduce the failure")

  const repositoryRoot = path.resolve(requireString(event.repository_root, "repository_root"))
  const patchManifest = event.continuity?.patch_manifest
  if (!Array.isArray(patchManifest) || patchManifest.length === 0) {
    blocked("Fallback requires a non-empty hash-bound patch manifest")
  }
  for (const [index, item] of patchManifest.entries()) {
    const target = path.resolve(requireString(item?.path, `continuity.patch_manifest[${index}].path`))
    const relative = path.relative(repositoryRoot, target)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      blocked("Patch target escapes the canonical repository root", { target, repositoryRoot })
    }
    requireString(item.expected_before_sha256, `continuity.patch_manifest[${index}].expected_before_sha256`)
    requireString(item.expected_after_sha256, `continuity.patch_manifest[${index}].expected_after_sha256`)
  }

  const validationCommands = uniqueStrings(event.continuity?.validation_commands, "continuity.validation_commands")
  if (validationCommands.length === 0) blocked("At least one bounded validation command is required")
  if (event.continuity?.host_patch_applier_verified !== true) {
    blocked("Hash-bound local patch applier must be verified before sandbox fallback")
  }
  if (event.continuity?.test_route?.provider) validateRoute(event.continuity.test_route)

  return {
    status: "contained-continuity-approved",
    incident: "windows_spawnchild_error_2",
    operation_id: common.operationId,
    affected_scope: {
      repository_root: repositoryRoot,
      sandbox_stage: stage,
      windows_error_code: errorCode,
    },
    quarantine: [
      "Disable only the failing Windows Codex sandbox execution path",
      "Keep the canonical worktree, operation ID, and external-write ledger active",
      "Do not weaken ACLs, disable the sandbox, or retry unsandboxed",
    ],
    continuity: {
      planning_route: common.route,
      patch_application: "verified local hash-bound atomic patch applier",
      patch_manifest: patchManifest,
      validation_commands: validationCommands,
      test_route: event.continuity?.test_route || null,
      instructions: [
        "Generate or review the patch through the pinned approved route",
        "Verify every before-hash immediately before writing",
        "Write through a same-directory temporary file and atomic rename",
        "Verify every after-hash and run git diff --check",
        "Run validations on an explicitly authorized local Linux/WSL/container route when Windows sandbox execution remains unavailable",
        "Reconcile results into the original operation ledger without importing or replaying the session",
      ],
    },
    resume_condition: [
      "The physical stable Codex binary passes a harmless SpawnChild canary",
      "codex doctor includes and passes child-process launch validation",
      "Two consecutive sandboxed shell and patch canaries complete without error 2",
    ],
  }
}

export function evaluate(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) blocked("Input must be a JSON object")
  const common = validateCommon(event)
  switch (event.incident) {
    case "approval_deadlock":
      return approvalDeadlockPlan(event, common)
    case "windows_spawnchild_error_2":
      return windowsSpawnChildPlan(event, common)
    default:
      blocked("Unsupported incident type", { incident: event.incident })
  }
}

function readInput(args) {
  if (args.input) return JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"))
  const stdin = fs.readFileSync(0, "utf8").trim()
  if (!stdin) blocked("Provide --input <json-file> or JSON on stdin")
  return JSON.parse(stdin)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = evaluate(readInput(parseArgs(process.argv.slice(2))))
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ status: "blocked", message: error.message, ...(error.details || {}) }, null, 2))
    process.exit(2)
  }
}
