#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const guard = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'codex-plugin-effective-capability-guard.mjs',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-capability-'));

function run(name, evidence) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 });
  const result = spawnSync(process.execPath, [guard, '--input', file, '--json'], {
    encoding: 'utf8',
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

const base = {
  schema_version: 1,
  write_authority_requested: true,
  remote_plugin_catalog_enabled: true,
  account_plan: 'pro',
  plugins: [
    {
      plugin_id: 'build-ios-apps@openai-curated',
      installed: true,
      enabled: true,
      required_for_task: true,
      disabledReason: null,
      eligiblePlanTypes: ['pro', 'business'],
      expected: { skills: 9, mcp_servers: 0, apps: 0, hooks: 0 },
      effective: { skills: 9, mcp_servers: 0, apps: 0, hooks: 0 },
    },
  ],
};

const healthy = run('healthy', base);
assert.equal(healthy.status, 0);
assert.equal(healthy.json.status, 'verified');
assert.equal(healthy.json.write_authority_permitted, true);

const suppressed = structuredClone(base);
suppressed.plugins[0].effective.skills = 0;
const blocked = run('suppressed', suppressed);
assert.equal(blocked.status, 75);
assert.equal(blocked.json.status, 'plugin_eligibility_or_capability_mismatch');
assert.equal(blocked.json.findings[0].silent_suppression, true);
assert.equal(blocked.json.write_authority_permitted, false);

const disabled = structuredClone(base);
disabled.plugins[0].enabled = false;
const disabledResult = run('disabled', disabled);
assert.equal(disabledResult.status, 75);
assert.equal(disabledResult.json.findings[0].inventory_mismatch, true);

const catalogDisabled = structuredClone(base);
catalogDisabled.plugins[0].disabledReason = 'admin_disabled';
const catalogDisabledResult = run('catalog-disabled', catalogDisabled);
assert.equal(catalogDisabledResult.status, 75);
assert.equal(catalogDisabledResult.json.findings[0].eligibility_disabled, true);
assert.equal(catalogDisabledResult.json.findings[0].disabled_reason, 'admin_disabled');

const unknownDisabled = structuredClone(base);
unknownDisabled.plugins[0].disabledReason = 'unknown';
const unknownDisabledResult = run('unknown-disabled', unknownDisabled);
assert.equal(unknownDisabledResult.status, 75);
assert.equal(unknownDisabledResult.json.findings[0].eligibility_disabled, true);

const planIneligible = structuredClone(base);
planIneligible.account_plan = 'free';
const planIneligibleResult = run('plan-ineligible', planIneligible);
assert.equal(planIneligibleResult.status, 75);
assert.equal(planIneligibleResult.json.findings[0].plan_eligibility_mismatch, true);

const legacyMetadata = structuredClone(base);
delete legacyMetadata.account_plan;
delete legacyMetadata.plugins[0].disabledReason;
delete legacyMetadata.plugins[0].eligiblePlanTypes;
const legacyMetadataResult = run('legacy-metadata', legacyMetadata);
assert.equal(legacyMetadataResult.status, 0);
assert.equal(legacyMetadataResult.json.status, 'verified');

const prohibited = structuredClone(base);
prohibited.plugins[0].plugin_id = 'claude-bridge@openai-curated';
const prohibitedResult = run('prohibited', prohibited);
assert.equal(prohibitedResult.status, 64);
assert.equal(prohibitedResult.json.status, 'rejected');

const advisory = structuredClone(suppressed);
advisory.plugins[0].required_for_task = false;
const advisoryResult = run('advisory', advisory);
assert.equal(advisoryResult.status, 0);
assert.equal(advisoryResult.json.status, 'verified');

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write('plugin effective capability guard self-test passed\n');
