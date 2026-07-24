import path from "node:path"
import { nowIso, parseArgs, randomId, sha256, stateRoot, writeJsonAtomic } from "./lib.mjs"

const args = parseArgs(process.argv.slice(2))
if (!args.action || !args.payload) {
  console.error("Usage: bun operator:queue --action update_contact --payload '{\"id\":1}' [--idempotency-key key]")
  process.exit(2)
}

let payload
try {
  payload = JSON.parse(args.payload)
} catch (error) {
  console.error(`Invalid JSON payload: ${error.message}`)
  process.exit(2)
}

const operationId = args["operation-id"] || randomId("action")
const record = {
  operation_id: operationId,
  idempotency_key: args["idempotency-key"] || randomId("idem"),
  action: args.action,
  payload,
  payload_hash: `sha256:${sha256(JSON.stringify(payload))}`,
  status: "pending",
  attempt_count: 0,
  provider: null,
  verification_required: true,
  created_at: nowIso(),
  updated_at: nowIso(),
}

const file = path.join(stateRoot(args), "queue", "pending", `${operationId}.json`)
writeJsonAtomic(file, record)
console.log(file)
