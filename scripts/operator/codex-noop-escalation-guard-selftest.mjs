#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, "codex-noop-escalation-guard.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-noop-escalation-"));

function run(name, evidence) {
  const file = path.join(temp, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const result = spawnSync(process.execPath, [guard, "--input", file, "--json"], {
    encoding: "utf8",
  });
  const output = JSON.parse(result.stdout || result.stderr);
  return { result, output };
}

try {
  const noOp = run("noop", {
    effective: {
      sandboxMode: "danger-full-access",
      permissionProfile: "disabled",
      filesystem: "unrestricted",
      network: "enabled",
    },
    toolCall: {
      sandboxPermissions: "require_escalated",
      justification: "retry with unrestricted network",
      prefixRule: ["nix", "develop"],
    },
    retry: { planned: true, uncertainWritesReconciled: true },
    routing: { provider: "OpenAI", selector: "pinned" },
  });
  assert.equal(noOp.result.status, 75);
  assert.equal(noOp.output.status, "remediation-required");
  assert.equal(noOp.output.fullAccess, true);
  assert.ok(noOp.output.remediations.some((item) => item.includes("no-op sandbox escalation")));
  assert.ok(noOp.output.remediations.some((item) => item.includes("prefix rule")));

  const restricted = run("restricted", {
    effective: {
      sandboxMode: "workspace-write",
      permissionProfile: "workspace",
      filesystem: "workspace-only",
      network: "restricted",
    },
    toolCall: { sandboxPermissions: "require_escalated" },
    routing: { provider: "OpenAI", selector: "pinned" },
  });
  assert.equal(restricted.result.status, 0);
  assert.equal(restricted.output.status, "admitted");

  const unsafeRetry = run("unsafe-retry", {
    effective: { sandboxMode: "danger-full-access" },
    toolCall: { sandboxPermissions: "default" },
    retry: { planned: true, uncertainWritesReconciled: false },
    routing: { provider: "OpenAI", selector: "pinned" },
  });
  assert.equal(unsafeRetry.result.status, 64);
  assert.equal(unsafeRetry.output.status, "policy-violation");

  const prohibited = run("prohibited", {
    effective: { sandboxMode: "workspace-write" },
    toolCall: { sandboxPermissions: "default" },
    routing: { provider: "OpenAI", gateway: "automatic model gateway" },
  });
  assert.equal(prohibited.result.status, 64);
  assert.equal(prohibited.output.status, "policy-violation");

  process.stdout.write("codex-noop-escalation-guard self-test passed\n");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
