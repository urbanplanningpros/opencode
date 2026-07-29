#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXIT = Object.freeze({ OK: 0, MALFORMED: 2, POLICY: 64 });
const DISABLED_FEATURES = ["plugins", "remote_plugin", "plugin_sharing", "skill_search"];
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

function fail(message, code = EXIT.POLICY) {
  console.error(`codex-plugin-authority-safe-launch: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  let dryRun = false;
  let separator = argv.indexOf("--");
  if (separator === -1) separator = argv.length;

  const wrapperArgs = argv.slice(0, separator);
  const codexArgs = separator < argv.length ? argv.slice(separator + 1) : [];

  for (const arg of wrapperArgs) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.error(
        "Usage: node codex-plugin-authority-safe-launch.mjs [--dry-run] -- <codex arguments>",
      );
      process.exit(EXIT.OK);
    } else {
      fail(`unknown wrapper argument: ${arg}`, EXIT.MALFORMED);
    }
  }

  if (codexArgs.length === 0) {
    fail("Codex arguments are required after --", EXIT.MALFORMED);
  }

  return { dryRun, codexArgs };
}

function inspectConfig() {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) return;

  const resolvedHome = path.resolve(codexHome);
  const configPath = path.join(resolvedHome, "config.toml");
  if (!fs.existsSync(configPath)) return;

  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("CODEX_HOME/config.toml must be a regular non-symlink file");
  }

  const text = fs.readFileSync(configPath, "utf8");
  const forbiddenConfig = DISABLED_FEATURES.filter((feature) => {
    const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s*${escaped}\\s*=\\s*true\\s*(?:#.*)?$`, "mi").test(text);
  });

  if (forbiddenConfig.length > 0) {
    fail(`config attempts to enable blocked features: ${forbiddenConfig.join(", ")}`);
  }

  if (BLOCKED_ROUTE_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("config contains a prohibited provider, gateway, selector, or deployment route");
  }
}

function inspectArguments(args) {
  const joined = args.join(" ");
  if (BLOCKED_ROUTE_PATTERNS.some((pattern) => pattern.test(joined))) {
    fail("arguments contain a prohibited provider, gateway, selector, or deployment route");
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1] ?? "";

    if (arg === "--enable" && DISABLED_FEATURES.includes(next)) {
      fail(`attempt to enable blocked feature: ${next}`);
    }
    if (arg.startsWith("--enable=")) {
      const feature = arg.slice("--enable=".length);
      if (DISABLED_FEATURES.includes(feature)) {
        fail(`attempt to enable blocked feature: ${feature}`);
      }
    }
    if ((arg === "-c" || arg === "--config") && next) {
      for (const feature of DISABLED_FEATURES) {
        const pattern = new RegExp(`(?:features\\.)?${feature}\\s*=\\s*true`, "i");
        if (pattern.test(next)) fail(`config override enables blocked feature: ${feature}`);
      }
    }
  }
}

function inspectEnvironment() {
  const environmentMaterial = JSON.stringify(process.env);
  if (BLOCKED_ROUTE_PATTERNS.some((pattern) => pattern.test(environmentMaterial))) {
    fail("environment contains a prohibited provider, gateway, selector, or deployment route");
  }
}

const { dryRun, codexArgs } = parseArgs(process.argv.slice(2));
inspectArguments(codexArgs);
inspectConfig();
inspectEnvironment();

const binary = process.env.CODEX_BIN || "codex";
const enforcedArgs = [
  ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ...codexArgs,
];

const receipt = {
  binary,
  argv: enforcedArgs,
  disabledFeatures: DISABLED_FEATURES,
  attestation: "strict-no-plugin-route",
};

if (dryRun) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(EXIT.OK);
}

const result = spawnSync(binary, enforcedArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    OPERATOR_CODEX_PLUGIN_AUTHORITY_MODE: "strict-no-plugin-route",
  },
});

if (result.error) fail(result.error.message, EXIT.MALFORMED);
if (result.signal) fail(`Codex terminated by signal ${result.signal}`, EXIT.MALFORMED);
process.exit(result.status ?? EXIT.MALFORMED);
