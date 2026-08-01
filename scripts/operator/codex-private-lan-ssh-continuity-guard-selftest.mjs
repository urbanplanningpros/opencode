#!/usr/bin/env node
import assert from "node:assert/strict"
import {
  buildPlan,
  classifyIpv4,
  environmentPermitsExecution,
  validateRemoteCommand,
  verifyReceipt,
} from "./codex-private-lan-ssh-continuity-guard.mjs"

const base = {
  operationId: "op-36438-canary",
  provider: "openai",
  automaticModelSelection: false,
  fallbackChain: [],
  host: "192.168.10.25",
  port: 22,
  user: "codex",
  knownHosts: "/tmp/operator-known-hosts",
  identityLabel: "nas-admin-key",
  command: ["/usr/local/bin/operator-canary", "--operation-id", "op-36438-canary"],
}

assert.equal(classifyIpv4("10.0.0.1"), "rfc1918")
assert.equal(classifyIpv4("172.31.255.254"), "rfc1918")
assert.equal(classifyIpv4("192.168.1.1"), "rfc1918")
assert.equal(classifyIpv4("8.8.8.8"), "public")
assert.equal(classifyIpv4("127.0.0.1"), "loopback")

const plan = buildPlan(base)
assert.equal(plan.route, "authorized-local-executor")
assert.equal(plan.execute_inside_codex_remote, false)
assert.equal(plan.model_route.provider, "openai")
assert.equal(plan.model_route.automatic_model_selection, false)
assert.deepEqual(plan.model_route.fallback_chain, [])
assert.equal(plan.destination.classification, "rfc1918")
assert.ok(plan.args.includes("StrictHostKeyChecking=yes"))
assert.ok(plan.plan_sha256.length === 64)

assert.throws(() => buildPlan({ ...base, host: "8.8.8.8" }), /RFC1918/)
assert.throws(() => buildPlan({ ...base, provider: "gateway-provider" }), /not approved/)
assert.throws(() => buildPlan({ ...base, automaticModelSelection: true }), /Automatic model selection/)
assert.throws(() => buildPlan({ ...base, gateway: "some-gateway" }), /gateways/)
assert.throws(() => buildPlan({ ...base, fallbackChain: ["other"] }), /Fallback chains/)
assert.throws(() => validateRemoteCommand(["echo", "hello;rm"]), /Unsafe remote command token/)

assert.deepEqual(environmentPermitsExecution({ OPERATOR_AUTHORIZED_LOCAL_EXECUTOR: "1" }), {
  authorized: true,
  inside_remote: false,
  permitted: true,
})
assert.deepEqual(environmentPermitsExecution({ OPERATOR_AUTHORIZED_LOCAL_EXECUTOR: "1", CODEX_REMOTE: "1" }), {
  authorized: true,
  inside_remote: true,
  permitted: false,
})
assert.equal(environmentPermitsExecution({}).permitted, false)

const successfulReceipt = {
  ...plan,
  status: "completed",
  result: { exit_code: 0 },
}
assert.equal(verifyReceipt(successfulReceipt, base.operationId), true)
assert.throws(() => verifyReceipt({ ...successfulReceipt, status: "failed" }, base.operationId), /did not complete/)
assert.throws(() => verifyReceipt(successfulReceipt, "different-op"), /operation ID mismatch/)

console.log("codex-private-lan-ssh-continuity-guard: 18 deterministic checks passed")
