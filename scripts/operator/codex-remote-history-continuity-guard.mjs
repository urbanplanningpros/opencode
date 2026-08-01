import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback
  if (value === true || value === "true" || value === "1") return true
  if (value === false || value === "false" || value === "0") return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function positiveInteger(value, name, fallback = null) {
  if (value === undefined && fallback !== null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const input = fs.createReadStream(file)
    input.on("error", reject)
    input.on("data", (chunk) => hash.update(chunk))
    input.on("end", () => resolve(hash.digest("hex")))
  })
}

function writeJsonAtomic(file, value) {
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, absolute)
  return absolute
}

const args = parseArgs(process.argv.slice(2))

try {
  const operationId = String(args["operation-id"] || "").trim()
  const threadId = String(args["thread-id"] || "").trim()
  if (!operationId || !threadId) throw new Error("--operation-id and --thread-id are required")

  const provider = String(args.provider || "openai").trim().toLowerCase()
  if (!new Set(["openai", "authorized-local"]).has(provider)) {
    throw new Error("provider must be openai or authorized-local")
  }
  const model = String(args.model || "").trim()
  if (provider === "openai" && !model) throw new Error("--model is required for provider=openai")
  if (bool(args["automatic-model-selection"], false)) throw new Error("automatic model selection is not allowed")
  if (args.gateway && String(args.gateway).trim()) throw new Error("model gateways are not allowed")
  if (args.fallbacks && String(args.fallbacks).trim() && String(args.fallbacks).trim() !== "[]") {
    throw new Error("fallback chains are not allowed")
  }

  const thresholdBytes = positiveInteger(
    args["max-remote-bytes"] ?? process.env.OPERATOR_CODEX_REMOTE_MAX_BYTES,
    "max-remote-bytes",
    96 * 1024 * 1024,
  )

  let rolloutPath = null
  let rolloutBytes = null
  let rolloutMtime = null
  if (args.rollout) {
    rolloutPath = path.resolve(String(args.rollout))
    const stat = fs.statSync(rolloutPath)
    if (!stat.isFile()) throw new Error("--rollout must point to a file")
    rolloutBytes = stat.size
    rolloutMtime = stat.mtime.toISOString()
  } else {
    rolloutBytes = positiveInteger(args["rollout-bytes"], "rollout-bytes")
  }

  const itemCount = args["item-count"] === undefined ? null : positiveInteger(args["item-count"], "item-count")
  const oversized = rolloutBytes >= thresholdBytes
  const shouldHash = bool(args["hash-rollout"], false)
  const rolloutSha256 = rolloutPath && shouldHash ? await sha256File(rolloutPath) : null
  const observedAt = new Date().toISOString()

  const result = {
    schema_version: 1,
    observed_at: observedAt,
    operation_id: operationId,
    thread_id: threadId,
    route: {
      provider,
      model: model || null,
      automatic_model_selection: false,
      gateway: null,
      fallbacks: [],
    },
    rollout: {
      path: rolloutPath,
      bytes: rolloutBytes,
      item_count: itemCount,
      mtime: rolloutMtime,
      sha256: rolloutSha256,
    },
    policy: {
      max_remote_bytes: thresholdBytes,
      remote_full_read_allowed: !oversized,
      remote_fork_allowed: !oversized,
    },
    decision: oversized ? "local_or_successor_required" : "remote_read_allowed",
    continuity: oversized
      ? {
          preserve: [
            "operation_id",
            "thread_id",
            "canonical worktree and commit",
            "completed tool and external-write receipts",
            "rollout identity and optional SHA-256",
          ],
          allowed: [
            "continue the existing thread on the host through a direct approved route",
            "read recent history through paginated APIs when the client supports them",
            "create one independent successor thread from a concise verified handoff",
          ],
          denied: [
            "remote full thread/read hydration",
            "forking the oversized thread",
            "blind task replay or duplicate child creation",
            "deleting or editing Codex state databases or rollout files",
          ],
          resume_remote_full_read_when: [
            "the client uses paginated history or a larger verified envelope",
            "three open/reconnect canaries complete without host disconnect",
            "the returned thread identity and worktree match the manifest",
          ],
        }
      : null,
  }

  if (args.manifest) result.manifest_file = writeJsonAtomic(String(args.manifest), result)
  process.stdout.write(`${JSON.stringify(result, null, bool(args.json, false) ? 0 : 2)}\n`)
  if (oversized && bool(args["assert-safe"], false)) process.exit(78)
} catch (error) {
  console.error(`Codex remote-history guard failed: ${error.message}`)
  process.exit(64)
}
