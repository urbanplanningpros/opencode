#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROHIBITED = [
  'anthropic',
  'claude',
  'manus',
  'bedrock',
  'vertex',
  'openrouter',
  'copilot-auto',
  'auto-select',
  'automatic-model-selection',
];

function fail(message, exitCode = 2, json = false) {
  const payload = { status: 'invalid', message };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { input: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      if (!argv[i + 1]) throw new Error('--input requires a path');
      options.input = argv[i + 1];
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: codex-plugin-effective-capability-guard.mjs --input <evidence.json> [--json]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.input) throw new Error('--input is required');
  return options;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
}

function assertNullableString(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be null or a non-empty string`);
  }
  return value.trim();
}

function assertNullableStringArray(value, label) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error(`${label} must be null or an array`);
  const normalized = value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  return [...new Set(normalized)];
}

function readAlias(object, snakeName, camelName, label) {
  const snakePresent = Object.hasOwn(object, snakeName);
  const camelPresent = Object.hasOwn(object, camelName);
  if (snakePresent && camelPresent) {
    const snake = JSON.stringify(object[snakeName]);
    const camel = JSON.stringify(object[camelName]);
    if (snake !== camel) throw new Error(`${label} aliases disagree`);
  }
  if (snakePresent) return object[snakeName];
  if (camelPresent) return object[camelName];
  return null;
}

function assertCountObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const normalized = {};
  for (const key of ['skills', 'mcp_servers', 'apps', 'hooks']) {
    const count = value[key] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label}.${key} must be a non-negative integer`);
    }
    normalized[key] = count;
  }
  return normalized;
}

function containsProhibitedIdentifier(value) {
  const text = JSON.stringify(value).toLowerCase();
  return PROHIBITED.find((token) => text.includes(token)) ?? null;
}

function canonicalInputPath(input) {
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('input must be a regular, non-symlink file');
  }
  if (stat.size > 1024 * 1024) throw new Error('input exceeds 1 MiB');
  return resolved;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message, 2, process.argv.includes('--json'));
  }

  let evidence;
  try {
    const inputPath = canonicalInputPath(options.input);
    evidence = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    fail(`could not read evidence: ${error.message}`, 2, options.json);
  }

  let accountPlan;
  try {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error('evidence must be an object');
    }
    if (evidence.schema_version !== 1) throw new Error('schema_version must equal 1');
    assertBoolean(evidence.write_authority_requested, 'write_authority_requested');
    assertBoolean(evidence.remote_plugin_catalog_enabled, 'remote_plugin_catalog_enabled');
    accountPlan = assertNullableString(evidence.account_plan ?? null, 'account_plan');
    if (!Array.isArray(evidence.plugins) || evidence.plugins.length === 0) {
      throw new Error('plugins must be a non-empty array');
    }
  } catch (error) {
    fail(error.message, 2, options.json);
  }

  const prohibited = containsProhibitedIdentifier(evidence);
  if (prohibited) {
    const result = {
      status: 'rejected',
      reason: 'prohibited_route_or_provider_identifier',
      identifier: prohibited,
      write_authority_permitted: false,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(64);
  }

  const findings = [];
  const seen = new Set();

  try {
    for (const [index, plugin] of evidence.plugins.entries()) {
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
        throw new Error(`plugins[${index}] must be an object`);
      }
      const pluginId = plugin.plugin_id;
      if (typeof pluginId !== 'string' || pluginId.trim() === '') {
        throw new Error(`plugins[${index}].plugin_id must be a non-empty string`);
      }
      if (seen.has(pluginId)) throw new Error(`duplicate plugin_id: ${pluginId}`);
      seen.add(pluginId);
      assertBoolean(plugin.installed, `${pluginId}.installed`);
      assertBoolean(plugin.enabled, `${pluginId}.enabled`);
      assertBoolean(plugin.required_for_task, `${pluginId}.required_for_task`);
      const expected = assertCountObject(plugin.expected, `${pluginId}.expected`);
      const effective = assertCountObject(plugin.effective, `${pluginId}.effective`);
      const disabledReason = assertNullableString(
        readAlias(plugin, 'disabled_reason', 'disabledReason', `${pluginId}.disabledReason`),
        `${pluginId}.disabledReason`,
      );
      const eligiblePlanTypes = assertNullableStringArray(
        readAlias(
          plugin,
          'eligible_plan_types',
          'eligiblePlanTypes',
          `${pluginId}.eligiblePlanTypes`,
        ),
        `${pluginId}.eligiblePlanTypes`,
      );

      const missing = {};
      let missingTotal = 0;
      for (const key of Object.keys(expected)) {
        const delta = Math.max(0, expected[key] - effective[key]);
        missing[key] = delta;
        missingTotal += delta;
      }

      const inventoryMismatch = plugin.required_for_task && (!plugin.installed || !plugin.enabled);
      const eligibilityDisabled = plugin.required_for_task && disabledReason !== null;
      const planEligibilityMismatch =
        plugin.required_for_task &&
        accountPlan !== null &&
        eligiblePlanTypes !== null &&
        !eligiblePlanTypes.includes(accountPlan);
      const capabilityDrift = plugin.required_for_task && missingTotal > 0;
      const silentSuppression =
        evidence.remote_plugin_catalog_enabled &&
        plugin.installed &&
        plugin.enabled &&
        Object.values(expected).reduce((sum, count) => sum + count, 0) > 0 &&
        Object.values(effective).reduce((sum, count) => sum + count, 0) === 0;

      if (
        inventoryMismatch ||
        eligibilityDisabled ||
        planEligibilityMismatch ||
        capabilityDrift ||
        silentSuppression
      ) {
        findings.push({
          plugin_id: pluginId,
          required_for_task: plugin.required_for_task,
          installed: plugin.installed,
          enabled: plugin.enabled,
          account_plan: accountPlan,
          disabled_reason: disabledReason,
          eligible_plan_types: eligiblePlanTypes,
          expected,
          effective,
          missing,
          inventory_mismatch: inventoryMismatch,
          eligibility_disabled: eligibilityDisabled,
          plan_eligibility_mismatch: planEligibilityMismatch,
          capability_drift: capabilityDrift,
          silent_suppression: silentSuppression,
          suppression_reason: plugin.suppression_reason ?? null,
        });
      }
    }
  } catch (error) {
    fail(error.message, 2, options.json);
  }

  const blocked = findings.some((finding) => finding.required_for_task);
  const result = {
    status: blocked ? 'plugin_eligibility_or_capability_mismatch' : 'verified',
    remote_plugin_catalog_enabled: evidence.remote_plugin_catalog_enabled,
    account_plan: accountPlan,
    write_authority_requested: evidence.write_authority_requested,
    write_authority_permitted: !blocked,
    task_execution_permitted: !blocked,
    findings,
    remediation: blocked
      ? [
          'Use v2 PluginSummary disabledReason and eligiblePlanTypes as admission evidence when present.',
          'Do not rely on plugin inventory installed/enabled flags as capability evidence.',
          'Do not retry installation when disabledReason is non-null; resolve the reported admin, policy, or plan eligibility condition.',
          'Capture a fresh effective skills/MCP/apps/hooks catalog from the active runtime.',
          'For required OpenAI-curated skills only, add exact reviewed local skill roots explicitly, then recapture the effective catalog.',
          'Do not infer MCP, app, or hook authority from skill-root recovery.',
          'Reconcile uncertain external writes before retrying the task.',
        ]
      : [],
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(blocked ? 75 : 0);
}

main();
