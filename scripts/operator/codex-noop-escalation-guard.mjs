#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const EXIT = Object.freeze({ OK: 0, MALFORMED: 2, POLICY: 64, REMEDIATE: 75 });
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

function usage() {
  console.error(
    "Usage: node codex-noop-escalation-guard.mjs --input <evidence.json> [--json]",
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
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!input) throw new Error("--input is required");
  return { input, json };
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function readEvidence(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("evidence must be a regular non-symlink file");
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("evidence root must be an object");
  }
  return parsed;
}

function routeMaterial(evidence) {
  return JSON.stringify({
    provider: evidence.routing?.provider,
    runtime: evidence.routing?.runtime,
    fallback: evidence.routing?.fallback,
    selector: evidence.routing?.selector,
    gateway: evidence.routing?.gateway,
    deployment: evidence.routing?.deployment,
  });
}

function isFullAccess(effective) {
  const sandboxMode = normalize(effective?.sandboxMode ?? effective?.sandboxPolicy?.type);
  const permissionProfile = normalize(effective?.permissionProfile?.type ?? effective?.permissionProfile);
  const filesystem = normalize(effective?.filesystem);
  const network = normalize(effective?.network);

  return (
    sandboxMode === "danger-full-access" ||
    (permissionProfile === "disabled" &&
      ["unrestricted", "full", "enabled"].includes(filesystem) &&
      ["enabled", "unrestricted", "full"].includes(network))
  );
}

function evaluate(evidence) {
  const violations = [];
  const remediations = [];
  const toolCall = evidence.toolCall ?? {};
  const requestMode = normalize(toolCall.sandboxPermissions ?? toolCall.sandbox_permissions);
  const fullAccess = isFullAccess(evidence.effective ?? {});
  const hasPrefixRule = Array.isArray(toolCall.prefixRule ?? toolCall.prefix_rule)
    ? (toolCall.prefixRule ?? toolCall.prefix_rule).length > 0
    : Boolean(toolCall.prefixRule ?? toolCall.prefix_rule);

  const routes = routeMaterial(evidence);
  if (BLOCKED_ROUTE_PATTERNS.some((pattern) => pattern.test(routes))) {
    violations.push("prohibited provider, gateway, selector, or deployment route detected");
  }

  if (fullAccess && requestMode === "require-escalated") {
    remediations.push(
      "reject the no-op sandbox escalation; the active permission profile is already unrestricted",
    );
    remediations.push(
      "classify the underlying failure independently as transient, deterministic, policy, or dependency-related",
    );
    remediations.push(
      "preserve task state and reconcile uncertain writes before any retry",
    );
    remediations.push(
      "retry the same idempotent command at most once through the same pinned approved route without require_escalated",
    );
    remediations.push(
      "use ordinary execution-policy approval for intrinsically risky commands without claiming a sandbox bypass",
    );
    if (hasPrefixRule) {
      remediations.push("do not persist a reusable prefix rule for a no-op escalation");
    }
  }

  if (evidence.retry?.planned === true && evidence.retry?.uncertainWritesReconciled !== true) {
    violations.push("retry planned before uncertain external writes were reconciled");
  }

  const status = violations.length > 0 ? "policy-violation" : remediations.length > 0 ? "remediation-required" : "admitted";
  const exitCode = violations.length > 0 ? EXIT.POLICY : remediations.length > 0 ? EXIT.REMEDIATE : EXIT.OK;

  return {
    schemaVersion: 1,
    status,
    exitCode,
    fullAccess,
    requestedSandboxPermission: requestMode || null,
    violations,
    remediations,
    protocol: {
      preserveState: true,
      reconcileUncertainWritesBeforeRetry: true,
      automaticModelSelectionAllowed: false,
      reusableNoOpEscalationRuleAllowed: false,
      approvedContinuityRoutes: ["pinned-openai", "explicitly-authorized-local"],
    },
  };
}

try {
  const { input, json } = parseArgs(process.argv.slice(2));
  const result = evaluate(readEvidence(input));
  const output = json ? JSON.stringify(result, null, 2) : `${result.status}: ${[...result.violations, ...result.remediations].join("; ")}`;
  process.stdout.write(`${output}\n`);
  process.exit(result.exitCode);
} catch (error) {
  const result = {
    schemaVersion: 1,
    status: "malformed-evidence",
    exitCode: EXIT.MALFORMED,
    error: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(EXIT.MALFORMED);
}
