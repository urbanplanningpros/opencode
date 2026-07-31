import assert from "node:assert/strict"
import { evaluate } from "./codex-approval-sandbox-continuity-guard.mjs"

const approvedOpenAIRoute = {
  provider: "openai",
  model: "gpt-5.6-sol",
  automatic_model_selection: false,
  gateway: null,
  fallbacks: [],
}

function approvalFixture() {
  return {
    incident: "approval_deadlock",
    operation_id: "op-approval-1",
    thread_id: "thread-1",
    task_id: "task-1",
    pending_approval_request_id: "approval-1",
    task_status: "waitingOnApproval",
    latest_item: { type: "fileChange", status: "inProgress" },
    persisted_terminal_approval_response: false,
    pending_request_age_seconds: 120,
    state_reconciled: true,
    external_writes_reconciled: true,
    requested_actions: [],
    route: approvedOpenAIRoute,
    continuity: {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      network_access: false,
      preauthorized_bounded_mutation: true,
      write_roots: ["/workspace/project"],
      allowed_files: ["src/a.ts"],
    },
  }
}

function windowsFixture() {
  return {
    incident: "windows_spawnchild_error_2",
    operation_id: "op-windows-1",
    error_code: 2,
    failure_stage: "SpawnChild",
    helper_resolution_verified: true,
    resources_verified: true,
    sandbox_canary_failed: true,
    repository_root: "/workspace/project",
    state_reconciled: true,
    external_writes_reconciled: true,
    requested_actions: [],
    route: approvedOpenAIRoute,
    continuity: {
      host_patch_applier_verified: true,
      patch_manifest: [
        {
          path: "/workspace/project/src/a.ts",
          expected_before_sha256: "a".repeat(64),
          expected_after_sha256: "b".repeat(64),
        },
      ],
      validation_commands: ["npm test -- --runInBand"],
      test_route: {
        provider: "local",
        runtime: "authorized-linux-container",
        authorized_local: true,
        automatic_model_selection: false,
        gateway: null,
        fallbacks: [],
      },
    },
  }
}

function expectBlocked(name, mutate, expected) {
  const fixture = mutate()
  assert.throws(() => evaluate(fixture), (error) => {
    assert.match(error.message, expected, name)
    return true
  })
}

const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

test("approves bounded approval-deadlock continuity", () => {
  const result = evaluate(approvalFixture())
  assert.equal(result.status, "contained-continuity-approved")
  assert.equal(result.incident, "approval_deadlock")
  assert.equal(result.continuity.approval_policy, "never")
})

test("rejects approval fallback without reconciled writes", () => {
  expectBlocked("reconciliation", () => ({ ...approvalFixture(), external_writes_reconciled: false }), /reconciled/)
})

test("rejects non-fileChange approval signature", () => {
  const fixture = approvalFixture()
  fixture.latest_item.type = "shellCommand"
  expectBlocked("signature", () => fixture, /signature/)
})

test("rejects a fresh approval as not yet stranded", () => {
  expectBlocked("age", () => ({ ...approvalFixture(), pending_request_age_seconds: 5 }), /too new/)
})

test("rejects approval fallback that adds network authority", () => {
  const fixture = approvalFixture()
  fixture.continuity.network_access = true
  expectBlocked("network", () => fixture, /network/)
})

test("rejects approval fallback outside workspace-write", () => {
  const fixture = approvalFixture()
  fixture.continuity.sandbox_mode = "danger-full-access"
  expectBlocked("sandbox", () => fixture, /workspace-write/)
})

test("rejects approval fallback that still depends on interactive approval", () => {
  const fixture = approvalFixture()
  fixture.continuity.approval_policy = "on-request"
  expectBlocked("approval", () => fixture, /approval_policy=never/)
})

test("approves bounded Windows SpawnChild error-2 continuity", () => {
  const result = evaluate(windowsFixture())
  assert.equal(result.status, "contained-continuity-approved")
  assert.equal(result.incident, "windows_spawnchild_error_2")
  assert.equal(result.continuity.patch_application, "verified local hash-bound atomic patch applier")
})

test("rejects Windows classification without helper verification", () => {
  expectBlocked("helper", () => ({ ...windowsFixture(), helper_resolution_verified: false }), /Helper/)
})

test("rejects Windows fallback without a failed canary", () => {
  expectBlocked("canary", () => ({ ...windowsFixture(), sandbox_canary_failed: false }), /canary/)
})

test("rejects patch target outside repository", () => {
  const fixture = windowsFixture()
  fixture.continuity.patch_manifest[0].path = "/workspace/other/escape.ts"
  expectBlocked("escape", () => fixture, /escapes/)
})

test("rejects Windows fallback without verified patch applier", () => {
  const fixture = windowsFixture()
  fixture.continuity.host_patch_applier_verified = false
  expectBlocked("applier", () => fixture, /patch applier/)
})

test("rejects unsafe broad recovery actions", () => {
  const fixture = windowsFixture()
  fixture.requested_actions = ["disable-sandbox"]
  expectBlocked("unsafe", () => fixture, /Unsafe recovery action/)
})

test("rejects automatic model selection", () => {
  const fixture = approvalFixture()
  fixture.route = { ...approvedOpenAIRoute, automatic_model_selection: true }
  expectBlocked("auto", () => fixture, /Automatic model selection/)
})

test("rejects gateways", () => {
  const fixture = approvalFixture()
  fixture.route = { ...approvedOpenAIRoute, gateway: "some-router" }
  expectBlocked("gateway", () => fixture, /gateways/)
})

test("rejects excluded providers", () => {
  const fixture = approvalFixture()
  fixture.route = { ...approvedOpenAIRoute, provider: "anthropic", model: "excluded" }
  expectBlocked("provider", () => fixture, /not approved|prohibited/)
})

test("rejects unauthorized local routes", () => {
  const fixture = approvalFixture()
  fixture.route = {
    provider: "local",
    runtime: "linux",
    authorized_local: false,
    automatic_model_selection: false,
    gateway: null,
    fallbacks: [],
  }
  expectBlocked("local", () => fixture, /explicit authorization/)
})

test("rejects unknown incident types", () => {
  expectBlocked("unknown", () => ({ ...approvalFixture(), incident: "unknown" }), /Unsupported incident/)
})

let passed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    passed += 1
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}
console.log(JSON.stringify({ status: "ok", passed, total: tests.length }))
