#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, "codex-plugin-install-authority-guard.mjs");
const launcher = path.join(here, "codex-plugin-authority-safe-launch.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-authority-"));

function runGuard(name, evidence) {
  const input = path.join(tempRoot, `${name}.json`);
  fs.writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [guard, "--input", input, "--json"], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: JSON.parse(result.stdout),
    stderr: result.stderr,
  };
}

function baseEvidence() {
  return {
    codexVersion: "0.146.0",
    provider: "openai",
    route: { type: "direct-openai" },
    effectivePlugins: [],
    modelVisibleSkills: [],
    approvedPlugins: [],
  };
}

const approved = baseEvidence();
approved.effectivePlugins = [
  {
    id: "approved-operator@openai-curated-remote",
    version: "1.0.0",
    source: { type: "remote" },
    installed: true,
    enabled: true,
    installPolicy: "REQUIRED",
    installPolicySource: "workspace-admin",
    mustShowInstallationInterstitial: false,
    authPolicy: "ON_INSTALL",
    skillRoots: ["/approved/skills"],
  },
];
approved.modelVisibleSkills = [
  {
    name: "approved-operator:run",
    pluginId: "approved-operator@openai-curated-remote",
  },
];
approved.approvedPlugins = [
  {
    id: "approved-operator@openai-curated-remote",
    version: "1.0.0",
    consentReceiptSha256: "a".repeat(64),
    approvedBy: "operator",
    approvedAt: "2026-07-29T14:00:00Z",
    scopes: ["plugin-enable", "skill-injection"],
  },
];

const approvedResult = runGuard("approved", approved);
assert.equal(approvedResult.status, 0, approvedResult.stderr);
assert.equal(approvedResult.output.status, "admitted");

const injected = baseEvidence();
injected.effectivePlugins = [
  {
    id: "openai-developers@openai-curated-remote",
    version: "1.2.3",
    source: { type: "remote" },
    installed: true,
    enabled: true,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    mustShowInstallationInterstitial: true,
    authPolicy: "ON_INSTALL",
    skillRoots: ["/home/operator/.codex/plugins/cache/openai-developers/skills"],
  },
];
injected.modelVisibleSkills = [
  {
    name: "openai-developers:openai-platform-api-key",
    pluginId: "openai-developers@openai-curated-remote",
  },
];

const injectedResult = runGuard("injected", injected);
assert.equal(injectedResult.status, 75, injectedResult.stderr);
assert.equal(injectedResult.output.status, "remediation_required");
assert.deepEqual(injectedResult.output.contradictoryPlugins, [
  "openai-developers@openai-curated-remote",
]);

const recovered = structuredClone(injected);
recovered.recovery = {
  freshProfile: true,
  taskStatePreserved: true,
  uncertainWritesReconciled: true,
  effectiveCatalogRecaptured: true,
  disableFlags: ["plugins", "remote_plugin", "plugin_sharing", "skill_search"],
  recapturedEffectivePlugins: [],
  recapturedModelVisibleSkills: [],
};
const recoveredResult = runGuard("recovered", recovered);
assert.equal(recoveredResult.status, 0, recoveredResult.stderr);
assert.equal(recoveredResult.output.status, "recovered");

const prohibited = baseEvidence();
prohibited.gateway = "automatic-model-gateway";
const prohibitedResult = runGuard("prohibited", prohibited);
assert.equal(prohibitedResult.status, 64, prohibitedResult.stderr);
assert.equal(prohibitedResult.output.status, "rejected");

const cleanEnv = {
  PATH: process.env.PATH ?? "",
  HOME: tempRoot,
  CODEX_HOME: path.join(tempRoot, "codex-home"),
  CODEX_BIN: "codex",
};
fs.mkdirSync(cleanEnv.CODEX_HOME, { recursive: true });

const dryRun = spawnSync(
  process.execPath,
  [launcher, "--dry-run", "--", "exec", "--ephemeral", "-"],
  { encoding: "utf8", env: cleanEnv },
);
assert.equal(dryRun.status, 0, dryRun.stderr);
const dryRunReceipt = JSON.parse(dryRun.stdout);
for (const feature of ["plugins", "remote_plugin", "plugin_sharing", "skill_search"]) {
  const index = dryRunReceipt.argv.findIndex(
    (value, position, all) => value === "--disable" && all[position + 1] === feature,
  );
  assert.notEqual(index, -1, `missing --disable ${feature}`);
}

const reenable = spawnSync(
  process.execPath,
  [launcher, "--dry-run", "--", "--enable", "plugins", "exec", "-"],
  { encoding: "utf8", env: cleanEnv },
);
assert.equal(reenable.status, 64);
assert.match(reenable.stderr, /attempt to enable blocked feature: plugins/);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("codex-plugin-install-authority-guard self-test: passed");
