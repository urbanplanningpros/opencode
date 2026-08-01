#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPROVED_PROVIDERS = new Set(['openai', 'local']);
const APPROVED_MODELS = new Set(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']);
const EXIT_INTERVENTION_REQUIRED = 75;
const GIB = 1024 ** 3;

function fail(message) {
  throw new Error(message);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireFiniteNumber(value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) {
    fail(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function validateSha(value, name = 'expectedHead') {
  const sha = requireString(value, name).toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) {
    fail(`${name} must be a Git commit SHA`);
  }
  return sha;
}

function validateRepository(value) {
  const repository = requireString(value, 'repository').toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    fail(`invalid repository: ${value}`);
  }
  return repository;
}

function validateRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    fail('operatorRoute is required');
  }

  const provider = requireString(route.provider, 'operatorRoute.provider').toLowerCase();
  const model = requireString(route.model, 'operatorRoute.model').toLowerCase();
  if (!APPROVED_PROVIDERS.has(provider)) {
    fail(`unapproved provider: ${provider}`);
  }
  if (!APPROVED_MODELS.has(model)) {
    fail(`unapproved model: ${model}`);
  }
  if (route.automaticModelSelection !== false) {
    fail('automatic model selection must be disabled');
  }
  if (route.gateway !== null && route.gateway !== undefined && route.gateway !== '') {
    fail('model gateways are prohibited');
  }
  if (!Array.isArray(route.fallbacks) || route.fallbacks.length !== 0) {
    fail('fallback chains must be empty');
  }

  return {
    provider,
    model,
    automaticModelSelection: false,
    gateway: null,
    fallbacks: [],
  };
}

function normalizedRate(count, windowSeconds) {
  return (count / windowSeconds) * 60;
}

export function assessWindowsGitStorm(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('evidence must be an object');
  }

  const windowSeconds = requireFiniteNumber(evidence.windowSeconds, 'windowSeconds', 1);
  const gitStarts = requireFiniteNumber(evidence.gitStarts ?? 0, 'gitStarts');
  const directGitStarts = requireFiniteNumber(
    evidence.chatgptDirectGitStarts ?? 0,
    'chatgptDirectGitStarts',
  );
  const conhostStarts = requireFiniteNumber(evidence.conhostStarts ?? 0, 'conhostStarts');
  const directPowerShellStarts = requireFiniteNumber(
    evidence.chatgptDirectPowerShellStarts ?? 0,
    'chatgptDirectPowerShellStarts',
  );
  const commitUtilizationPercent = requireFiniteNumber(
    evidence.commitUtilizationPercent ?? 0,
    'commitUtilizationPercent',
  );
  const pageTableBytes = requireFiniteNumber(evidence.pageTableBytes ?? 0, 'pageTableBytes');
  const availablePhysicalBytes = requireFiniteNumber(
    evidence.availablePhysicalBytes ?? Number.MAX_SAFE_INTEGER,
    'availablePhysicalBytes',
  );

  const gitStartsPerMinute = normalizedRate(gitStarts, windowSeconds);
  const directGitStartsPerMinute = normalizedRate(directGitStarts, windowSeconds);
  const conhostStartsPerMinute = normalizedRate(conhostStarts, windowSeconds);
  const directPowerShellStartsPerMinute = normalizedRate(directPowerShellStarts, windowSeconds);

  const stormDetected = directGitStartsPerMinute >= 20 || gitStartsPerMinute >= 40;
  const criticalMemoryPressure =
    commitUtilizationPercent >= 85 ||
    pageTableBytes >= 4 * GIB ||
    availablePhysicalBytes <= 2 * GIB;

  return {
    stormDetected,
    criticalMemoryPressure,
    rates: {
      gitStartsPerMinute,
      directGitStartsPerMinute,
      conhostStartsPerMinute,
      directPowerShellStartsPerMinute,
    },
    memory: {
      commitUtilizationPercent,
      pageTableBytes,
      availablePhysicalBytes,
    },
    thresholds: {
      directGitStartsPerMinute: 20,
      totalGitStartsPerMinute: 40,
      commitUtilizationPercent: 85,
      pageTableBytes: 4 * GIB,
      availablePhysicalBytes: 2 * GIB,
    },
  };
}

export function buildWindowsGitStormContinuityPlan({
  operationId,
  repositoryRoot,
  expectedHead,
  evidence,
  operatorRoute,
}) {
  const route = validateRoute(operatorRoute);
  const assessment = assessWindowsGitStorm(evidence);
  const op = requireString(operationId, 'operationId');
  const repoRoot = path.resolve(requireString(repositoryRoot, 'repositoryRoot'));
  const head = validateSha(expectedHead);

  if (!assessment.stormDetected) {
    return {
      schemaVersion: 1,
      kind: 'codex-windows-gitstorm-continuity',
      generatedAt: new Date().toISOString(),
      operationId: op,
      status: 'no_material_signal',
      assessment,
      operatorRoute: route,
    };
  }

  return {
    schemaVersion: 1,
    kind: 'codex-windows-gitstorm-continuity',
    generatedAt: new Date().toISOString(),
    operationId: op,
    status: assessment.criticalMemoryPressure
      ? 'guided_intervention_required'
      : 'containment_required',
    assessment,
    scope: {
      restrict: [
        'codex-desktop-background-git-discovery',
        'codex-desktop-repository-mutation-authority',
      ],
      continue: [
        'pinned-codex-cli-repository-work',
        'direct-openai-operations',
        'authorized-local-execution',
        'unrelated-connectors-and-automations',
      ],
    },
    state: {
      repositoryRoot: repoRoot,
      expectedHead: head,
      preserve: [
        'operation_id',
        'task_id',
        'thread_id',
        'tool_call_id',
        'idempotency_key',
        'repository_head',
        'dirty_file_hashes',
        'active_child_process_inventory',
        'external_write_receipts',
      ],
    },
    approvedFallback: {
      executor: 'authorized-local-codex-cli',
      operatorRoute: route,
      preflight: [
        'Verify the exact repository root.',
        'Verify git rev-parse HEAD equals expectedHead.',
        'Hash every dirty file before continuing.',
        'Reconcile unfinished external writes before dispatch.',
      ],
      commandTemplate: ['codex', '--model', route.model],
    },
    immediateActions: [
      'Stop dispatching new Git discovery or review work from the affected Desktop process.',
      'Do not replay any turn whose mutation state is unknown.',
      'Continue only the unfinished segment through the pinned approved fallback after state reconciliation.',
      'Sample process-start rate and memory pressure every 60 seconds until stable.',
    ],
    guidedIntervention: {
      required: assessment.criticalMemoryPressure,
      reason: assessment.criticalMemoryPressure
        ? 'Host memory pressure is near an unsafe boundary; terminating Desktop or rebooting changes live process and task state.'
        : 'Not yet required if Desktop Git mutation authority can be isolated without terminating processes.',
      approvalRequiredBefore: [
        'terminating ChatGPT.exe or its child processes',
        'restarting Windows',
        'changing page-file settings',
        'removing stored projects or workspace metadata',
        'disabling Git globally',
        'changing production or external-write authority',
      ],
    },
    prohibitedAutomaticActions: [
      'kill all Git processes without parent and operation correlation',
      'reboot the host automatically',
      'delete repositories or Codex state databases',
      'disable Git system-wide',
      'increase permissions or bypass the sandbox',
      'replay completed mutations',
    ],
    resumeDesktopAuthorityWhen: [
      'Three consecutive ten-minute canaries show <= 2 ChatGPT-parented Git starts per minute.',
      'Commit utilization remains below 70% without an upward trend.',
      'Page-table growth remains below 128 MiB across each canary.',
      'Repository HEAD, dirty-file hashes, and external-write receipts reconcile.',
    ],
  };
}

function textFromResult(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function detectSandboxedGhKeyringFalseFailure(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('evidence must be an object');
  }

  const sandbox = evidence.sandboxCheck ?? {};
  const host = evidence.scopedHostCheck ?? {};
  const credentialStore = String(evidence.credentialStore ?? '').toLowerCase();
  const sandboxText = textFromResult(sandbox);
  const hostText = textFromResult(host);

  const sandboxAuthFailure =
    Number(sandbox.exitCode) !== 0 &&
    (/failed to log in/i.test(sandboxText) || /token[^\n]*invalid/i.test(sandboxText));
  const hostAuthSuccess =
    Number(host.exitCode) === 0 &&
    (/logged in to github\.com/i.test(hostText) || /active account:\s*true/i.test(hostText));
  const keyringConfirmed = credentialStore === 'keyring' || /\(keyring\)/i.test(hostText);

  return sandboxAuthFailure && hostAuthSuccess && keyringConfirmed;
}

function validateGhArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((item) => typeof item !== 'string')) {
    fail('ghArgv must be a string array beginning with gh');
  }
  if (argv[0] !== 'gh') {
    fail('ghArgv must begin with gh');
  }
  if (argv.some((item) => /[\n\r\0]/.test(item))) {
    fail('ghArgv contains an unsafe control character');
  }
  return [...argv];
}

function classifyGhMutation(argv) {
  const command = argv.slice(1).join(' ').toLowerCase();
  const mutationPatterns = [
    /^pr\s+(create|merge|close|reopen|edit|comment|review)/,
    /^issue\s+(create|close|reopen|edit|comment)/,
    /^repo\s+(create|delete|edit|archive|rename)/,
    /^release\s+(create|delete|edit|upload)/,
    /^workflow\s+run/,
    /^run\s+(cancel|rerun|delete)/,
    /^secret\s+set/,
    /^variable\s+set/,
    /^api\b.*(?:--method|-x)\s*(post|put|patch|delete)/,
  ];
  return mutationPatterns.some((pattern) => pattern.test(command));
}

export function buildScopedGhHostPlan({
  operationId,
  evidence,
  ghArgv,
  expectedAccount,
  repository,
  operatorRoute,
}) {
  const op = requireString(operationId, 'operationId');
  const route = validateRoute(operatorRoute);
  const argv = validateGhArgv(ghArgv);
  const account = requireString(expectedAccount, 'expectedAccount').toLowerCase();
  const repo = validateRepository(repository);
  const falseFailureDetected = detectSandboxedGhKeyringFalseFailure(evidence);
  const mutation = classifyGhMutation(argv);

  if (!falseFailureDetected) {
    return {
      schemaVersion: 1,
      kind: 'codex-github-keyring-continuity',
      generatedAt: new Date().toISOString(),
      operationId: op,
      status: 'no_matching_false_failure',
      operatorRoute: route,
    };
  }

  return {
    schemaVersion: 1,
    kind: 'codex-github-keyring-continuity',
    generatedAt: new Date().toISOString(),
    operationId: op,
    status: mutation ? 'guided_intervention_required' : 'scoped_host_retry_ready',
    diagnosis: {
      sandboxCredentialVisibility: 'unavailable',
      hostCredentialStatus: 'valid-keyring-backed',
      reauthenticationRequired: false,
    },
    identityBoundary: {
      expectedAccount: account,
      repository: repo,
      requireVerifiedActiveAccount: true,
      requireVerifiedRepositoryAccess: true,
    },
    scopedHostCommand: {
      argv,
      shell: false,
      operatorRoute: route,
      approvalScope: {
        executable: 'gh',
        exactArguments: argv.slice(1),
        host: 'github.com',
        oneOperationId: op,
      },
    },
    protocol: {
      doFirst: [
        'Preserve the sandbox failure output as evidence.',
        'Run the exact read-only gh auth status check with scoped host access.',
        'Verify the active account matches expectedAccount.',
        'Verify bounded access to the exact repository.',
      ],
      doNot: [
        'run gh auth login',
        'delete or replace keyring credentials',
        'export a token into the sandbox',
        'broaden host access beyond the exact gh argv',
        'retry through a gateway or automatic model selector',
      ],
    },
    guidedIntervention: {
      required: mutation,
      reason: mutation
        ? 'The requested gh command can create an external write and must be explicitly approved after identity verification.'
        : 'No additional intervention is required after the exact scoped host-read approval is granted.',
      verifyBeforeApproval: [
        'active GitHub account',
        'target repository',
        'exact argv',
        'idempotency key for any write',
        'expected pre-action state',
      ],
    },
  };
}

function writeJsonAtomic(outputPath, value) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, absolute);
  return absolute;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(requireString(filePath, 'JSON file')), 'utf8'));
}

function printResult(result, output) {
  if (output) {
    process.stdout.write(`${writeJsonAtomic(output, result)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === 'audit-windows-gitstorm') {
    const input = loadJson(args['evidence-file']);
    const result = buildWindowsGitStormContinuityPlan({
      operationId: args['operation-id'],
      repositoryRoot: args['repo-root'],
      expectedHead: args['expected-head'],
      evidence: input.evidence ?? input,
      operatorRoute: input.operatorRoute,
    });
    printResult(result, args.output);
    if (result.status === 'guided_intervention_required') {
      process.exitCode = EXIT_INTERVENTION_REQUIRED;
    }
    return;
  }

  if (command === 'audit-gh-keyring') {
    const input = loadJson(args['evidence-file']);
    const result = buildScopedGhHostPlan({
      operationId: args['operation-id'],
      evidence: input.evidence ?? input,
      ghArgv: input.ghArgv,
      expectedAccount: input.expectedAccount,
      repository: input.repository,
      operatorRoute: input.operatorRoute,
    });
    printResult(result, args.output);
    if (result.status === 'guided_intervention_required') {
      process.exitCode = EXIT_INTERVENTION_REQUIRED;
    }
    return;
  }

  process.stderr.write(
    [
      'Usage:',
      '  audit-windows-gitstorm --evidence-file FILE --operation-id ID --repo-root PATH --expected-head SHA [--output FILE]',
      '  audit-gh-keyring --evidence-file FILE --operation-id ID [--output FILE]',
    ].join('\n') + '\n',
  );
  process.exitCode = 64;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 64;
  }
}
