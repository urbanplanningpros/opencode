import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const guard = new URL("./codex-windows-work-sync-continuity-guard.mjs", import.meta.url).pathname
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-windows-work-sync-"))

const base = {
  task_id: "task-1",
  operation_id: "op-1",
  idempotency_key: "idem-1",
  object_type: "scheduled",
  source: {
    client: "windows_app",
    build: "26.721.41059",
    created_on_windows: true,
    expected_cloud_object: true,
  },
  visibility: {
    windows: true,
    web: true,
    mobile: true,
    canonical_record_id: "sched-1",
  },
  recovery: {
    source_object_preserved: true,
    local_receipt_hashed: true,
    external_writes_reconciled: true,
    duplicate_replacement_created: false,
    windows_work_creation_blocked: false,
    canonical_creation_attempted: false,
    canonical_creation_verified: false,
    schedule_trigger_verified: false,
    continuation_route: "windows_app",
  },
}

function run(name, evidence, expectedCode, expectedReason) {
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence))
  const result = spawnSync(process.execPath, [guard, "--input", file], { encoding: "utf8" })
  const stream = result.status === 0 ? result.stdout : result.stderr || result.stdout
  let parsed
  try { parsed = JSON.parse(stream) } catch { throw new Error(`${name}: invalid JSON\n${stream}`) }
  if (result.status !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${result.status}\n${stream}`)
  if (parsed.reason !== expectedReason) throw new Error(`${name}: expected ${expectedReason}, got ${parsed.reason}`)
}

run("healthy-scheduled-sync", structuredClone(base), 0, "windows_work_sync_continuity_verified")

const missing = structuredClone(base)
missing.visibility.web = false
missing.visibility.mobile = false
missing.visibility.canonical_record_id = ""
run("missing-scheduled-projection", missing, 75, "windows_scheduled_object_not_canonical")

const recovered = structuredClone(missing)
recovered.visibility.canonical_record_id = "sched-web-1"
recovered.recovery.windows_work_creation_blocked = true
recovered.recovery.canonical_creation_attempted = true
recovered.recovery.canonical_creation_verified = true
recovered.recovery.schedule_trigger_verified = true
recovered.recovery.continuation_route = "web_control_plane"
run("scheduled-recreated-canonically", recovered, 0, "scheduled_object_recreated_on_canonical_control_plane")

const project = structuredClone(missing)
project.object_type = "project_work"
run("missing-project-projection", project, 75, "windows_work_object_sync_unreconciled")

const projectRecovered = structuredClone(project)
projectRecovered.visibility.canonical_record_id = "project-web-1"
projectRecovered.recovery.windows_work_creation_blocked = true
projectRecovered.recovery.canonical_creation_attempted = true
projectRecovered.recovery.canonical_creation_verified = true
projectRecovered.recovery.continuation_route = "web_control_plane"
run("project-recreated-canonically", projectRecovered, 0, "work_object_recreated_on_canonical_control_plane")

const duplicate = structuredClone(recovered)
duplicate.recovery.duplicate_replacement_created = true
run("duplicate-replacement", duplicate, 64, "duplicate_work_object_creation_forbidden")

const prohibited = structuredClone(recovered)
prohibited.recovery.continuation_route = "model-gateway-auto-select"
run("prohibited-route", prohibited, 64, "prohibited_route_metadata")

console.log(JSON.stringify({ passed: 7 }, null, 2))
