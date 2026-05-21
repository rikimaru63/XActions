import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { features, featureCategories } from '../api/config/features.js';

const root = new URL('../', import.meta.url);
const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';

function envBool(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

const requireLive = envBool('XACTIONS_ACCEPTANCE_REQUIRE_LIVE');

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function hasAll(source, snippets) {
  return snippets.filter((snippet) => !source.includes(snippet));
}

function item(id, description, passed, evidence, missing = []) {
  return {
    id,
    description,
    status: passed ? 'passed' : 'failed',
    evidence,
    ...(missing.length ? { missing } : {}),
  };
}

function auditStaticAcceptance() {
  const dashboard = read('dashboard/console.html');
  const consoleRoute = read('api/routes/console.js');
  const accountsRoute = read('api/routes/accounts.js');
  const scheduledRoute = read('api/routes/scheduled-actions.js');
  const scheduledService = read('api/services/scheduledActions.js');
  const jobQueue = read('api/services/jobQueue.js');
  const accountStore = read('api/services/accountStore.js');
  const accountSelection = read('api/services/accountSelection.js');
  const uiSmoke = read('scripts/smoke-console-ui.js');
  const accountUiSmoke = read('scripts/smoke-console-ui-accounts.js');
  const workerRestartHost = read('scripts/smoke-console-worker-restart-host.sh');
  const productionSmoke = read('scripts/smoke-console-production-host.sh');
  const schema = read('prisma/schema.prisma');
  const pkg = JSON.parse(read('package.json'));

  const processorNames = new Set(
    [...jobQueue.matchAll(/operationsQueue\.process\(['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
  );
  const executableFeatures = features.filter((feature) => feature.id !== 'accounts');
  const requiredQueueTypes = [
    ...new Set(executableFeatures.map((feature) => feature.queueType || feature.operationType)),
  ];
  const missingProcessors = requiredQueueTypes.filter((type) => !processorNames.has(type));
  const unavailableFeatures = features.filter((feature) => feature.status !== 'available');
  const missingConsoleActions = executableFeatures.filter((feature) => !feature.consoleAction);
  const missingScheduleSupport = executableFeatures.filter((feature) => !feature.supportsSchedule);

  const detailMissing = hasAll(dashboard, [
    'id="feature-list"',
    'id="detail-summary"',
    'id="settings-panel"',
    'id="schedule-panel"',
    'id="history-panel"',
    'data-tab="settings"',
    'data-tab="schedule"',
    'data-tab="history"',
  ]);

  const accountCrudMissing = hasAll(accountsRoute, [
    "router.get('/'",
    "router.post('/'",
    "router.post('/:id/verify'",
    "router.patch('/:id'",
    "router.delete('/:id'",
    "router.post('/:id/default'",
  ]);

  const accountSelectionMissing = hasAll(accountSelection + dashboard + consoleRoute, [
    'MAX_ACCOUNT_SELECTION = 2',
    'explicitAccountIdsFromBody',
    'explicitAccountIdsFromQuery',
    'operationAccountHistoryWhere',
    'data-account-choice',
    'accountIds: collectAccountIds',
  ]);

  const schedulerMissing = hasAll(scheduledRoute + scheduledService + schema, [
    'model ScheduledAction',
    'model ScheduledActionRun',
    "router.post('/:id/run-now'",
    "router.post('/:id/pause'",
    "router.post('/:id/resume'",
    'processDueScheduledActions',
    'lockedAt',
    'lockedBy',
    'queueAttemptsForSchedule',
  ]);

  const historyMissing = hasAll(consoleRoute + scheduledRoute + schema + dashboard, [
    'scheduledActionId',
    'parentOperationId',
    'childOperations',
    "router.get('/history'",
    "router.get('/:id/runs'",
    'data-load-runs',
    'data-retry-failed',
  ]);

  const failureGuidanceMissing = hasAll(dashboard + uiSmoke, [
    'nextActionText',
    'detailWithGuidance',
    'failureGuidance',
    'historyRetryVisible',
  ]);

  const sessionExpiredMissing = hasAll(accountStore + accountUiSmoke + jobQueue, [
    'markAccountSessionExpired',
    'pauseActiveSchedulesForAccount',
    'isSessionExpiredError',
    'expiredAccountGuidance',
  ]);

  const workerRestartMissing = hasAll(workerRestartHost + productionSmoke, [
    'docker stop',
    'docker start',
    'smoke:console-worker-restart',
    'XACTIONS_PRODUCTION_WORKER_RESTART_SMOKE',
  ]);

  const productionMissing = hasAll(productionSmoke + JSON.stringify(pkg.scripts || {}), [
    '/api/health',
    '/console',
    'audit:console-acceptance',
    'audit:console-catalog',
    'verify:headless',
    'smoke:console-ui',
    'smoke:console-ui-accounts',
    'smoke:console-scheduler',
    'Scheduled action scheduler started',
  ]);

  const items = [
    item(
      'feature-catalog',
      'Every catalog feature is available and backed by a worker processor.',
      featureCategories.length >= 10
        && features.length >= 40
        && unavailableFeatures.length === 0
        && missingConsoleActions.length === 0
        && missingScheduleSupport.length === 0
        && missingProcessors.length === 0,
      {
        categories: featureCategories.length,
        features: features.length,
        queueTypes: requiredQueueTypes.length,
      },
      [
        ...unavailableFeatures.map((feature) => `${feature.id}: status=${feature.status}`),
        ...missingConsoleActions.map((feature) => `${feature.id}: missing consoleAction`),
        ...missingScheduleSupport.map((feature) => `${feature.id}: missing supportsSchedule`),
        ...missingProcessors.map((type) => `${type}: missing worker processor`),
      ]
    ),
    item(
      'feature-detail-navigation',
      'Clicking a feature exposes summary, settings, schedule, and history panels.',
      detailMissing.length === 0 && uiSmoke.includes('tabStates') && uiSmoke.includes('visitedFeatureTotal'),
      { script: 'smoke:console-ui' },
      detailMissing
    ),
    item(
      'multi-account-crud',
      'Users can manage multiple X accounts and default account selection.',
      accountCrudMissing.length === 0
        && schema.includes('model XAccount')
        && schema.includes('@@unique([userId, username])'),
      { route: 'api/routes/accounts.js', model: 'XAccount' },
      accountCrudMissing
    ),
    item(
      'execution-account-selection',
      'Execution and history filtering use explicit account selection with a maximum of two accounts.',
      accountSelectionMissing.length === 0,
      { maxAccounts: 2 },
      accountSelectionMissing
    ),
    item(
      'persistent-schedules',
      'Schedules are stored in the database, claimed with locks, and can be paused, resumed, and run now.',
      schedulerMissing.length === 0,
      { route: 'api/routes/scheduled-actions.js', service: 'api/services/scheduledActions.js' },
      schedulerMissing
    ),
    item(
      'operation-history',
      'Scheduled and multi-account execution remain visible through Operation history and run history.',
      historyMissing.length === 0,
      { route: 'api/routes/console.js', runRoute: 'api/routes/scheduled-actions.js' },
      historyMissing
    ),
    item(
      'failure-guidance',
      'Failed schedules, runs, and child operations show the reason and next action in the console.',
      failureGuidanceMissing.length === 0,
      { script: 'smoke:console-ui' },
      failureGuidanceMissing
    ),
    item(
      'worker-restart-recovery',
      'Host smoke can stop the worker and verify that due schedules are picked up after restart.',
      workerRestartMissing.length === 0,
      { script: 'scripts/smoke-console-worker-restart-host.sh' },
      workerRestartMissing
    ),
    item(
      'session-expired-ui',
      'Session-expired accounts are marked, their schedules are paused, and the UI shows recovery guidance.',
      sessionExpiredMissing.length === 0,
      { script: 'smoke:console-ui-accounts' },
      sessionExpiredMissing
    ),
    item(
      'production-smoke',
      'Production smoke covers health, console, catalog, headless browser, worker, scheduler, and UI checks.',
      productionMissing.length === 0,
      { script: 'scripts/smoke-console-production-host.sh' },
      productionMissing
    ),
  ];

  return {
    ok: items.every((entry) => entry.status === 'passed'),
    items,
  };
}

async function auditLiveReadiness() {
  const liveCookies = [
    process.env.XACTIONS_LIVE_ACCOUNT_A_COOKIE,
    process.env.XACTIONS_LIVE_ACCOUNT_B_COOKIE,
  ].map((value) => String(value || '').trim());
  const requestedIds = unique([
    ...envList('XACTIONS_LIVE_ACCOUNT_IDS'),
    process.env.XACTIONS_LIVE_ACCOUNT_A_ID,
    process.env.XACTIONS_LIVE_ACCOUNT_B_ID,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const requestedUsernames = unique([
    ...envList('XACTIONS_LIVE_ACCOUNT_USERNAMES'),
    process.env.XACTIONS_LIVE_ACCOUNT_A_USERNAME,
    process.env.XACTIONS_LIVE_ACCOUNT_B_USERNAME,
  ]
    .map((value) => String(value || '').replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean));
  const useExisting = envBool('XACTIONS_LIVE_USE_EXISTING_ACCOUNTS');
  const selectorCount = [
    requestedIds.length > 0,
    requestedUsernames.length > 0,
    useExisting,
  ].filter(Boolean).length;
  const readyWithCookies = Boolean(liveCookies[0] && liveCookies[1] && liveCookies[0] !== liveCookies[1]);

  if (!process.env.DATABASE_URL) {
    return {
      checked: false,
      ready: false,
      reason: 'DATABASE_URL is not set; live readiness was not checked.',
      liveCookies: {
        accountA: Boolean(liveCookies[0]),
        accountB: Boolean(liveCookies[1]),
        bothPresent: Boolean(liveCookies[0] && liveCookies[1]),
        different: readyWithCookies,
      },
    };
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { username: smokeUsername },
      select: { id: true, username: true },
    });
    const activeAccounts = user
      ? await prisma.xAccount.findMany({
          where: { userId: user.id, status: 'active' },
          select: {
            id: true,
            username: true,
            status: true,
            isDefault: true,
            lastVerifiedAt: true,
            updatedAt: true,
          },
          orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
          take: 10,
        })
      : [];
    const activeIds = new Set(activeAccounts.map((account) => account.id));
    const activeUsernames = new Set(activeAccounts.map((account) => String(account.username || '').toLowerCase()));
    const readyWithIds = requestedIds.length === 2 && requestedIds.every((id) => activeIds.has(id));
    const readyWithUsernames = requestedUsernames.length === 2
      && requestedUsernames.every((username) => activeUsernames.has(username));
    const readyWithFirstActive = useExisting && activeAccounts.length >= 2;
    const readyWithExistingAccounts = selectorCount === 1
      && (readyWithIds || readyWithUsernames || readyWithFirstActive);
    const reasons = [];
    if (!user) reasons.push(`Smoke user not found: ${smokeUsername}`);
    if (liveCookies[0] && liveCookies[1] && liveCookies[0] === liveCookies[1]) {
      reasons.push('XACTIONS_LIVE_ACCOUNT_A_COOKIE and XACTIONS_LIVE_ACCOUNT_B_COOKIE must be different.');
    }
    if (selectorCount > 1) reasons.push('Use only one existing-account selector at a time.');
    if (!readyWithCookies && !readyWithExistingAccounts) {
      reasons.push('Provide two live cookies or select exactly two active existing XAccounts.');
    }
    const ready = Boolean(user && (readyWithCookies || readyWithExistingAccounts));
    return {
      checked: true,
      ready,
      smokeUsername,
      smokeUserFound: Boolean(user),
      liveCookies: {
        accountA: Boolean(liveCookies[0]),
        accountB: Boolean(liveCookies[1]),
        bothPresent: Boolean(liveCookies[0] && liveCookies[1]),
        different: readyWithCookies,
      },
      existingSelectors: {
        ids: requestedIds.length,
        usernames: requestedUsernames.length,
        useFirstActive: useExisting,
        selectorCount,
      },
      activeXAccounts: activeAccounts.length,
      verifiedActiveXAccounts: activeAccounts.filter((account) => account.lastVerifiedAt).length,
      accounts: activeAccounts.map((account) => ({
        id: account.id,
        username: account.username,
        isDefault: account.isDefault,
        verified: Boolean(account.lastVerifiedAt),
      })),
      readyWithCookies,
      readyWithExistingAccounts,
      reasons,
      nextAction: ready
        ? 'Run smoke:console-live-readonly with existing accounts.'
        : 'Register two active XAccounts or provide two live cookies, then run smoke:console-live-readonly.',
    };
  } finally {
    await prisma.$disconnect();
  }
}

const staticAcceptance = auditStaticAcceptance();
const liveReadiness = await auditLiveReadiness();
const ok = staticAcceptance.ok && (!requireLive || liveReadiness.ready);

console.log(JSON.stringify({
  ok,
  requireLive,
  staticAcceptance,
  liveReadiness,
}, null, 2));

if (!ok) process.exit(1);
