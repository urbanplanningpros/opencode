#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const EXIT = Object.freeze({
  OK: 0,
  MALFORMED: 2,
  POLICY: 64,
  REMEDIATE: 75,
});

const BLOCKED_ROUTE_PATTERNS = [
  /anthropic/i,
  /claude/i,
  /manus/i,
  /bedrock/i,
  /vertex/i,
  /copilot/i,
  /openrouter/i,
  /model[\s_-]*gateway/i,
  /auto(?:matic)?[\s_-]*(?:model[\s_-]*)?(?:route|select)/i,
];

const REQUIRED_RECOVERY_DISABLES = [
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "skill_search",
];

function usage() {
  console.error(
    "Usage: node codex-plugin-install-authority-guard.mjs --input <evidence.json> [--json]",
  );
}

function parseArgs(argv) {
  let input = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      input = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(EXIT.OK);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!input) {
    throw new Error("--input is required");
  }

  return { input, json };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function normalizePluginId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("plugin id must be a non-empty string");
  }
  return value.trim().toLowerCase();
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function approvalKey(id, version) {
  return `${normalizePluginId(id)}@${String(version ?? "").trim()}`;
}

function activePlugin(plugin) {
  return Boolean(
    plugin.installed ||
      plugin.enabled ||
      (Array.isArray(plugin.skillRoots) && plugin.skillRoots.length > 0) ||
      (Array.isArray(plugin.mcpServers) && plugin.mcpServers.length > 0) ||
      (Array.isArray(plugin.apps) && plugin.apps.length > 0) ||
      (Array.isArray(plugin.hooks) && plugin.hooks.length > 0),
  );
}

function validApproval(approval, plugin) {
  if (!isObject(approval)) return false;
  if (normalizePluginId(approval.id) !== normalizePluginId(plugin.id)) return false;
  if (String(approval.version ?? "") !== String(plugin.version ?? "")) return false;
  if (!isSha256(approval.consentReceiptSha256)) return false;
  if (typeof approval.approvedBy !== "string" || approval.approvedBy.trim() === "") return false;
  if (typeof approval.approvedAt !== "string" || Number.isNaN(Date.parse(approval.approvedAt))) {
    return false;
  }
  const scopes = Array.isArray(approval.scopes) ? approval.scopes : [];
  return scopes.includes("plugin-enable") && scopes.includes("skill-injection");
}

function hasBlockedRoute(evidence) {
  const routeMaterial = JSON.stringify({
    route: evidence.route ?? null,
    provider: evidence.provider ?? null,
    modelProvider: evidence.modelProvider ?? null,
    fallback: evidence.fallback ?? null,
    gateway: evidence.gateway ?? null,
    selector: evidence.selector ?? null,
    environment: evidence.environment ?? null,
  });
  return BLOCKED_ROUTE_PATTERNS.some((pattern) => pattern.test(routeMaterial));
}

function contradictoryRemoteState(plugin) {
  return (
    plugin.source?.type === "remote" &&
    plugin.installed === true &&
    plugin.enabled === true &&
    plugin.installPolicy === "AVAILABLE" &&
    plugin.mustShowInstallationInterstitial === true &&
    plugin.authPolicy === "ON_INSTALL" &&
    (plugin.installPolicySource === null || plugin.installPolicySource === undefined)
  );
}

function verifyRecovery(recovery) {
  if (!isObject(recovery)) {
    return { ok: false, reasons: ["recovery evidence is missing"] };
  }

  const reasons = [];
  if (recovery.freshProfile !== true) reasons.push("freshProfile must be true");
  if (recovery.taskStatePreserved !== true) reasons.push("taskStatePreserved must be true");
  if (recovery.uncertainWritesReconciled !== true) {
    reasons.push("uncertainWritesReconciled must be true");
  }
  if (recovery.effectiveCatalogRecaptured !== true) {
    reasons.push("effectiveCatalogRecaptured must be true");
  }

  const disableFlags = Array.isArray(recovery.disableFlags) ? recovery.disableFlags : [];
  for (const feature of REQUIRED_RECOVERY_DISABLES) {
    if (!disableFlags.includes(feature)) reasons.push(`disableFlags must include ${feature}`);
  }

  const recapturedPlugins = Array.isArray(recovery.recapturedEffectivePlugins)
    ? recovery.recapturedEffectivePlugins
    : null;
  if (!recapturedPlugins) {
    reasons.push("recapturedEffectivePlugins must be an array");
  } else if (recapturedPlugins.some(activePlugin)) {
    reasons.push("recapturedEffectivePlugins still contains active plugin capability");
  }

  const recapturedSkills = Array.isArray(recovery.recapturedModelVisibleSkills)
    ? recovery.recapturedModelVisibleSkills
    : null;
  if (!recapturedSkills) {
    reasons.push("recapturedModelVisibleSkills must be an array");
  } else if (recapturedSkills.length > 0) {
    reasons.push("recapturedModelVisibleSkills must be empty on the strict recovery route");
  }

  return { ok: reasons.length === 0, reasons };
}

function evaluate(evidence) {
  if (!isObject(evidence)) {
    throw new Error("evidence root must be an object");
  }

  if (hasBlockedRoute(evidence)) {
    return {
      exitCode: EXIT.POLICY,
      status: "rejected",
      reason: "prohibited provider, gateway, selector, or deployment route detected",
    };
  }

  const effectivePlugins = asArray(evidence.effectivePlugins ?? [], "effectivePlugins");
  const modelVisibleSkills = asArray(
    evidence.modelVisibleSkills ?? [],
    "modelVisibleSkills",
  );
  const approvals = asArray(evidence.approvedPlugins ?? [], "approvedPlugins");

  const approvalMap = new Map();
  for (const approval of approvals) {
    if (!isObject(approval)) throw new Error("approvedPlugins entries must be objects");
    approvalMap.set(approvalKey(approval.id, approval.version), approval);
  }

  const unauthorizedPlugins = [];
  const contradictoryPlugins = [];
  const approvedPluginIds = new Set();

  for (const plugin of effectivePlugins) {
    if (!isObject(plugin)) throw new Error("effectivePlugins entries must be objects");
    const id = normalizePluginId(plugin.id);
    const approval = approvalMap.get(approvalKey(id, plugin.version));
    const isApproved = validApproval(approval, plugin);

    if (isApproved) approvedPluginIds.add(id);
    if (activePlugin(plugin) && !isApproved) unauthorizedPlugins.push(plugin.id);
    if (contradictoryRemoteState(plugin) && !isApproved) {
      contradictoryPlugins.push(plugin.id);
    }
  }

  const unauthorizedSkills = [];
  for (const skill of modelVisibleSkills) {
    if (!isObject(skill)) throw new Error("modelVisibleSkills entries must be objects");
    const pluginId = normalizePluginId(skill.pluginId);
    if (!approvedPluginIds.has(pluginId)) {
      unauthorizedSkills.push(skill.name ?? `${skill.pluginId}:<unnamed>`);
    }
  }

  const hasViolation =
    unauthorizedPlugins.length > 0 ||
    contradictoryPlugins.length > 0 ||
    unauthorizedSkills.length > 0;

  if (!hasViolation) {
    return {
      exitCode: EXIT.OK,
      status: "admitted",
      reason: "all active plugin capabilities are bound to exact local approval receipts",
      approvedPluginCount: approvedPluginIds.size,
    };
  }

  const recovery = verifyRecovery(evidence.recovery);
  if (recovery.ok) {
    return {
      exitCode: EXIT.OK,
      status: "recovered",
      reason: "unapproved plugin capability was isolated through a fresh strict no-plugin route",
      unauthorizedPlugins,
      contradictoryPlugins,
      unauthorizedSkills,
    };
  }

  return {
    exitCode: EXIT.REMEDIATE,
    status: "remediation_required",
    reason: "model-visible plugin capability is not bound to an explicit exact approval receipt",
    unauthorizedPlugins,
    contradictoryPlugins,
    unauthorizedSkills,
    recoveryFailures: recovery.reasons,
  };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(`[${result.status}] ${result.reason}`);
  for (const key of [
    "unauthorizedPlugins",
    "contradictoryPlugins",
    "unauthorizedSkills",
    "recoveryFailures",
  ]) {
    if (Array.isArray(result[key]) && result[key].length > 0) {
      console.log(`${key}: ${result[key].join(", ")}`);
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const stat = fs.lstatSync(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("input must be a regular non-symlink file");
  }

  const evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = evaluate(evidence);
  printResult(result, args.json);
  process.exit(result.exitCode);
} catch (error) {
  const result = {
    exitCode: EXIT.MALFORMED,
    status: "malformed",
    reason: error instanceof Error ? error.message : String(error),
  };
  printResult(result, process.argv.includes("--json"));
  process.exit(EXIT.MALFORMED);
}
