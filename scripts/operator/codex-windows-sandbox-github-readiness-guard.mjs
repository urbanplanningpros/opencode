#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPROVED_MODELS = new Set(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']);
const APPROVED_PROVIDERS = new Set(['openai', 'local']);
const EXIT_INTERVENTION_REQUIRED = 75;

function fail(message) {
  throw new Error(message);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeRepoName(value) {
  const repo = requireString(value, 'repository').toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
    fail(`invalid repository name: ${value}`);
  }
  return repo;
}

function validateOperatorRoute(route) {
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

  return { provider, model };
}

export function detectWindowsSandboxRefreshFailure(logText) {
  const text = String(logText ?? '');
  const hasLockFailure = /helper_sandbox_lock_failed/i.test(text);
  const hasSandboxBin = /\.sandbox-bin/i.test(text);
  const hasAclFailure =
    /SetNamedSecurityInfoW[^\n\r]*(?:failed:\s*5|ERROR_ACCESS_DENIED)/i.test(text) ||
    /SetNamedSecurityInfoW sandbox dir failed:\s*5/i.test(text);

  return hasLockFailure && hasSandboxBin && hasAclFailure;
}

export function buildWindowsSandboxContinuityPlan({
  operationId,
  repositoryRoot,
  expectedHead,
  logSha256,
  wslDistribution = 'Ubuntu',
  wslRepositoryRoot,
  model = 'gpt-5.6-terra',
}) {
  const op = requireString(operationId, 'operationId');
  const repoRoot = path.resolve(requireString(repositoryRoot, 'repositoryRoot'));
  const head = requireString(expectedHead, 'expectedHead');
  const distro = requireString(wslDistribution, 'wslDistribution');
  const wslRoot = requireString(wslRepositoryRoot, 'wslRepositoryRoot');
  if (!/^[0-9a-f]{7,64}$/i.test(head)) {
    fail('expectedHead must be a Git commit SHA');
  }
  if (!APPROVED_MODELS.has(model)) {
    fail(`unapproved model: ${model}`);
  }

  return {
    schemaVersion: 1,
    kind: 'codex-windows-sandbox-continuity',
    generatedAt: new Date().toISOString(),
    operationId: op,
    detection: {
      signature: 'helper_sandbox_lock_failed:SetNamedSecurityInfoW:ERROR_ACCESS_DENIED:.sandbox-bin',
      logSha256: requireString(logSha256, 'logSha256'),
    },
    scope: {
      blocked: ['native-windows-codex-cli-workspace-write'],
      unaffected: [
        'repository-analysis',
        'read-only-github-connector',
        'approved-openai-api-operations',
        'approved-local-linux-or-wsl-execution',
      ],
    },
    state: {
      repositoryRoot: repoRoot,
      expectedHead: head.toLowerCase(),
      preserve: [
        'operation_id',
        'thread_id',
        'task_id',
        'idempotency_key',
        'repository_head',
        'dirty_file_hashes',
        'external_write_receipts',
      ],
    },
    approvedFallback: {
      executor: 'wsl',
      provider: 'openai',
      model,
      automaticModelSelection: false,
      gateway: null,
      fallbacks: [],
      argv: [
        'wsl.exe',
        '--distribution',
        distro,
        '--',
        'bash',
        '-lc',
        'cd -- "$1" && test "$(git rev-parse HEAD)" = "$2" && exec codex --model "$3"',
        'operator-codex',
        wslRoot,
        head.toLowerCase(),
        model,
      ],
    },
    guidedIntervention: {
      required: true,
      reason: 'The failing native route involves Windows ACL ownership and permission state.',
      approveOneOf: [
        'Use the prepared WSL route after verifying the exact repository and commit.',
        'Allow a Windows administrator to repair or recreate only the affected .sandbox-bin directory after preserving evidence.',
      ],
      prohibitedAutomaticActions: [
        'take ownership of .sandbox-bin',
        'rewrite its DACL',
        'delete or rename .sandbox-bin',
        'broaden filesystem permissions',
        'replay completed external writes',
      ],
    },
    resumeNativeWindowsWhen: [
      'Codex initializes the existing .sandbox-bin on three consecutive launches.',
      'The effective sandbox remains workspace-write with the expected approval policy.',
      'A bounded file-write canary succeeds only inside the intended workspace.',
    ],
  };
}

export function auditGitHubInstallationEvidence({ operationId, evidence }) {
  const op = requireString(operationId, 'operationId');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('evidence must be an object');
  }

  const route = validateOperatorRoute(evidence.operatorRoute);
  const requiredRepositories = (evidence.requiredRepositories ?? []).map(normalizeRepoName);
  if (requiredRepositories.length === 0) {
    fail('requiredRepositories must contain at least one repository');
  }

  const accessible = new Set((evidence.accessibleRepositories ?? []).map(normalizeRepoName));
  const installations = Array.isArray(evidence.installations) ? evidence.installations : [];
  const installedAccounts = new Set(
    installations
      .filter((item) => item && item.appInstalled === true)
      .map((item) => requireString(item.account, 'installation.account').toLowerCase()),
  );

  const identityAuthenticated = evidence.identityAuthenticated === true;
  const missingInstallationTargets = [];
  const inaccessibleRepositories = [];

  for (const repo of requiredRepositories) {
    const [owner] = repo.split('/');
    if (!installedAccounts.has(owner)) {
      missingInstallationTargets.push(owner);
    }
    if (!accessible.has(repo)) {
      inaccessibleRepositories.push(repo);
    }
  }

  const ready =
    identityAuthenticated &&
    missingInstallationTargets.length === 0 &&
    inaccessibleRepositories.length === 0;

  return {
    schemaVersion: 1,
    kind: 'codex-github-installation-readiness',
    generatedAt: new Date().toISOString(),
    operationId: op,
    status: ready ? 'ready' : 'guided_intervention_required',
    operatorRoute: {
      provider: route.provider,
      model: route.model,
      automaticModelSelection: false,
      gateway: null,
      fallbacks: [],
    },
    evidence: {
      identityAuthenticated,
      installedAccounts: [...installedAccounts].sort(),
      requiredRepositories,
      accessibleRepositories: [...accessible].sort(),
    },
    gaps: {
      missingInstallationTargets: [...new Set(missingInstallationTargets)].sort(),
      inaccessibleRepositories: [...new Set(inaccessibleRepositories)].sort(),
    },
    protocol: ready
      ? {
          allowReadOnlyCanary: true,
          allowMutation: false,
          nextStep: 'Run a bounded read-only repository metadata and file-fetch canary before any write authority is granted.',
        }
      : {
          allowReadOnlyCanary: false,
          allowMutation: false,
          preserveExistingHealthyConnections: true,
          guidedIntervention: {
            required: true,
            actions: [
              'Confirm the GitHub identity is authenticated.',
              'Install the ChatGPT Codex Connector GitHub App on each exact required account or organization.',
              'Grant least-privilege access to the exact required repositories.',
              'Run a read-only get-repository and fetch-file canary for every required repository.',
            ],
          },
          doNot: [
            'treat OAuth identity authentication as proof of GitHub App installation',
            'repeatedly disconnect and reconnect without checking installation targets',
            'grant all-repository access when selected-repository access is sufficient',
            'route repository work through an automatic model selector or gateway',
          ],
        },
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function writeJsonAtomic(outputPath, value) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, absolute);
  return absolute;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printResult(result, output) {
  if (output) {
    const saved = writeJsonAtomic(output, result);
    process.stdout.write(`${saved}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === 'audit-windows') {
    const logFile = path.resolve(requireString(args['log-file'], '--log-file'));
    const logText = fs.readFileSync(logFile, 'utf8');
    if (!detectWindowsSandboxRefreshFailure(logText)) {
      printResult(
        {
          schemaVersion: 1,
          kind: 'codex-windows-sandbox-continuity',
          status: 'no_matching_failure',
          logSha256: sha256File(logFile),
        },
        args.output,
      );
      return;
    }

    const plan = buildWindowsSandboxContinuityPlan({
      operationId: args['operation-id'],
      repositoryRoot: args['repo-root'],
      expectedHead: args['expected-head'],
      logSha256: sha256File(logFile),
      wslDistribution: args['wsl-distribution'] || 'Ubuntu',
      wslRepositoryRoot: args['wsl-repo-root'],
      model: args.model || 'gpt-5.6-terra',
    });
    printResult({ ...plan, status: 'guided_intervention_required' }, args.output);
    process.exitCode = EXIT_INTERVENTION_REQUIRED;
    return;
  }

  if (command === 'audit-github') {
    const evidenceFile = path.resolve(requireString(args['evidence-file'], '--evidence-file'));
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    const result = auditGitHubInstallationEvidence({
      operationId: args['operation-id'],
      evidence,
    });
    printResult(result, args.output);
    if (result.status !== 'ready') {
      process.exitCode = EXIT_INTERVENTION_REQUIRED;
    }
    return;
  }

  process.stderr.write(
    [
      'Usage:',
      '  audit-windows --log-file FILE --operation-id ID --repo-root PATH --expected-head SHA --wsl-repo-root PATH [--wsl-distribution NAME] [--model MODEL] [--output FILE]',
      '  audit-github --evidence-file FILE --operation-id ID [--output FILE]',
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
