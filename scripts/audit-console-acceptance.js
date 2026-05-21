import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { features, featureCategories } from '../api/config/features.js';
import {
  envBool,
  evaluateLiveReadiness,
  existingSelectorSummary,
  liveCookieSummary,
  parseLiveReadinessEnv,
} from './lib/consoleLiveReadiness.js';

const root = new URL('../', import.meta.url);
const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';

const requireLive = envBool(process.env, 'XACTIONS_ACCEPTANCE_REQUIRE_LIVE');

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
  const server = read('api/server.js');
  const consoleRoute = read('api/routes/console.js');
  const operationsRoute = read('api/routes/operations.js');
  const accountsRoute = read('api/routes/accounts.js');
  const messagesRoute = read('api/routes/messages.js');
  const sessionAuthRoute = read('api/routes/session-auth.js');
  const scheduledRoute = read('api/routes/scheduled-actions.js');
  const scheduledService = read('api/services/scheduledActions.js');
  const consoleActions = read('api/services/consoleActions.js');
  const featureConfig = read('api/config/features.js');
  const jobQueue = read('api/services/jobQueue.js');
  const queuePayload = read('api/services/queuePayload.js');
  const accountExecutionLock = read('api/services/accountExecutionLock.js');
  const accountStore = read('api/services/accountStore.js');
  const accountSelection = read('api/services/accountSelection.js');
  const uiSmoke = read('scripts/smoke-console-ui.js');
  const accountUiSmoke = read('scripts/smoke-console-ui-accounts.js');
  const liveAccountRegistration = read('scripts/register-console-live-accounts.js');
  const liveAccountRegistrationHost = read('scripts/register-console-live-accounts-host.sh');
  const liveSmokeDocs = read('docs/console-live-smoke.md');
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
  const sendDmFeature = features.find((feature) => feature.id === 'sendDM');

  const dedicatedDmMissing = [
    ...(!sendDmFeature ? ['sendDM feature missing'] : []),
    ...(sendDmFeature?.operationType !== 'sendDM' ? [`operationType=${sendDmFeature?.operationType}`] : []),
    ...(sendDmFeature?.queueType !== 'sendDM' ? [`queueType=${sendDmFeature?.queueType}`] : []),
    ...(sendDmFeature?.supportsDryRun !== false ? ['sendDM should be live-only'] : []),
    ...hasAll(consoleActions + jobQueue, [
      "case 'sendDM'",
      "operationType: 'sendDM'",
      'messageLength: dmMessage.length',
      "operationsQueue.process('sendDM'",
    ]),
  ];

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

  const dashboardRouteMissing = hasAll(server + dashboard, [
    "app.get('/dashboard'",
    "res.redirect(302, '/console')",
    "app.get('/classic-dashboard'",
    'dashboard/index.html',
    'href="/classic-dashboard"',
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

  const accountScopedHistoryMissing = hasAll(accountSelection + dashboard + consoleRoute + scheduledRoute + accountUiSmoke, [
    'function accountQuery',
    'accountIds=${encodeURIComponent(state.selectedAccountIds.join',
    'operationAccountHistoryWhere(allowedIds)',
    'where.accountId = allowedIds.length === 1 ? allowedIds[0] : { in: allowedIds }',
    'filterChecks',
    'historyByAccounts',
    'schedulesByAccounts',
  ]);

  const livePacingMissing = hasAll(accountExecutionLock + consoleActions, [
    'shouldThrottleAccountJob',
    'highRiskActionTypes',
    "'sendDM'",
    "'followEngagers'",
    "'keywordFollow'",
    'cooldownKey',
    'waitForCooldown',
    'setAccountCooldown',
    'XACTIONS_ACCOUNT_HIGH_RISK_COOLDOWN_MS',
    'hasDmMessage: !!dmMessage',
    '...(dmMessage ? { dmMessage } : {})',
  ]);

  const liveAccountRegistrationMissing = hasAll(
    liveAccountRegistration + liveAccountRegistrationHost + liveSmokeDocs + JSON.stringify(pkg.scripts || {}),
    [
      'register:console-live-accounts',
      'for await (const chunk of process.stdin)',
      'verifySessionCookie(account.cookie)',
      'encryptedCookie: encrypt(account.cookie)',
      'evaluateLiveReadiness',
      'read -rsp "$prompt"',
      'docker exec -i',
      'register-console-live-accounts-host.sh',
      "XACTIONS_LIVE_READONLY_SOURCE='existing'",
    ]
  );
  if (liveAccountRegistration.includes('console.log(account.cookie')
    || liveAccountRegistration.includes('console.log(cookie')) {
    liveAccountRegistrationMissing.push('live account registration logs cookie material');
  }

  const liveConfirmationMissing = hasAll(dashboard + uiSmoke, [
    'id="confirm-modal"',
    'function requestConfirmation',
    "title: '実行前の確認'",
    "title: '実行予約の確認'",
    "title: '再実行の確認'",
    '実際に操作されます',
    'confirmation.visible',
    'confirmation.confirmText === \'実行する\'',
  ]);
  if (dashboard.includes('window.confirm')) {
    liveConfirmationMissing.push('window.confirm is still used');
  }

  const numberFieldLimitMissing = features.flatMap((feature) => (feature.fields || [])
    .filter((field) => field.type === 'number')
    .flatMap((field) => {
      const missing = [];
      if (typeof field.min !== 'number') missing.push(`${feature.id}.${field.key}: missing min`);
      if (typeof field.max !== 'number') missing.push(`${feature.id}.${field.key}: missing max`);
      return missing;
    }));

  const bulkLimitMissing = [
    ...numberFieldLimitMissing,
    ...hasAll(accountSelection + consoleActions + featureConfig + dashboard, [
      'MAX_ACCOUNT_SELECTION = 2',
      'const MAX_DM_MESSAGE_LENGTH = 1000',
      '.slice(0, MAX_DM_MESSAGE_LENGTH)',
      'asNumber(config.maxLikes, 10, 1, 50)',
      'asNumber(config.maxFollows, 10, 1, 50)',
      'asNumber(config.maxComments, 3, 1, 20)',
      'asNumber(config.limit || config.maxUnfollows, 20, 1, 100)',
      'tweets.slice(0, 5000)',
      'maxlength="${field.max || \'\'}"',
      'max="${field.max ?? \'\'}"',
    ]),
  ];

  const legacySessionMissing = hasAll(accountStore + sessionAuthRoute + productionSmoke + JSON.stringify(pkg.scripts || {}), [
    'ensureDefaultAccountForUser',
    'encryptedCookie: user.sessionCookie',
    'Compatibility fallback',
    'upsertAccountForUser(updatedUser',
    'smoke:console-legacy-session',
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

  const queuePayloadMissing = hasAll(queuePayload + jobQueue, [
    'sanitizeQueueJobData',
    'restoreQueueJobConfig',
    'encryptedConfigKeysByType',
    "['postTweet', ['text']]",
    "['postThread', ['tweets']]",
    "['replyToTweet', ['text']]",
    "['autoComment', ['comment']]",
    "['createPoll', ['question', 'options']]",
    "['analyzeSentiment', ['text']]",
    "['priceCorrelation', ['tweets']]",
    "['agentCommand', ['text']]",
    "['runWorkflow', ['context']]",
    "['sendDM', ['message']]",
    "['targetEngage', ['dmMessage']]",
    'encryptedJobConfig',
    'sensitiveQueueKeys',
    'sessionCookie',
    "sanitized.authMethod = 'session'",
    'restoreQueueJobConfig(job.data)',
    'operationsQueue.add(sanitizedJobData.type, sanitizedJobData',
  ]);

  const legacyDmStorageMissing = hasAll(messagesRoute, [
    'messageLength: String(message).length',
    'hasMessage: true',
  ]);
  if (messagesRoute.includes('config: JSON.stringify({ username, message })')) {
    legacyDmStorageMissing.push('legacy DM route stores full message in Operation.config');
  }

  const legacyOperationRedactionMissing = hasAll(operationsRoute, [
    "import { sanitizeOperation } from '../services/consoleActions.js'",
    'res.json(sanitizeOperation(operation))',
    'operations: operations.map(sanitizeOperation)',
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
    '/dashboard',
    '/classic-dashboard',
    'audit:console-acceptance',
    'audit:console-catalog',
    'verify:headless',
    'smoke:console-ui',
    'smoke:console-ui-accounts',
    'smoke:console-legacy-session',
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
      'dedicated-dm-processor',
      'DM送信 uses the dedicated sendDM worker and is treated as a live-only action.',
      dedicatedDmMissing.length === 0,
      { feature: 'sendDM', processor: 'sendDM' },
      dedicatedDmMissing
    ),
    item(
      'feature-detail-navigation',
      'Clicking a feature exposes summary, settings, schedule, and history panels.',
      detailMissing.length === 0 && uiSmoke.includes('tabStates') && uiSmoke.includes('visitedFeatureTotal'),
      { script: 'smoke:console-ui' },
      detailMissing
    ),
    item(
      'dashboard-entrypoint',
      '/dashboard opens the Japanese console while the previous dashboard remains available as /classic-dashboard.',
      dashboardRouteMissing.length === 0,
      { route: '/dashboard', fallback: '/classic-dashboard' },
      dashboardRouteMissing
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
      'account-scoped-history-schedules',
      'History and schedule lists can be filtered by selected X accounts.',
      accountScopedHistoryMissing.length === 0,
      { script: 'smoke:console-ui-accounts', query: 'accountIds' },
      accountScopedHistoryMissing
    ),
    item(
      'live-action-pacing',
      'DM and follow live actions are serialized and spaced per X account.',
      livePacingMissing.length === 0,
      { service: 'api/services/accountExecutionLock.js', cooldownMs: 60000 },
      livePacingMissing
    ),
    item(
      'live-account-registration',
      'Operators can register two real X accounts for the final live readonly E2E without logging cookies.',
      liveAccountRegistrationMissing.length === 0,
      { script: 'register:console-live-accounts', hostScript: 'register-console-live-accounts-host.sh' },
      liveAccountRegistrationMissing
    ),
    item(
      'live-confirmation-modal',
      'Live execution, live schedules, and live reruns require an in-console confirmation before they start.',
      liveConfirmationMissing.length === 0,
      { ui: 'dashboard/console.html', smoke: 'smoke:console-ui' },
      liveConfirmationMissing
    ),
    item(
      'bulk-execution-limits',
      'Bulk and high-risk inputs have explicit UI and server-side limits before execution or scheduling.',
      bulkLimitMissing.length === 0,
      { maxAccounts: 2, dmMessageMax: 1000, highRiskActionMax: 50 },
      bulkLimitMissing
    ),
    item(
      'legacy-session-migration',
      'Users with only User.sessionCookie are migrated into a default XAccount and covered by production smoke.',
      legacySessionMissing.length === 0,
      { route: 'api/routes/session-auth.js', service: 'api/services/accountStore.js' },
      legacySessionMissing
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
      'queue-payload-secrets',
      'Queued jobs do not carry session cookies, token material, or plaintext user-authored bodies; workers restore protected data at execution time.',
      queuePayloadMissing.length === 0,
      { service: 'api/services/queuePayload.js', queue: 'api/services/jobQueue.js' },
      queuePayloadMissing
    ),
    item(
      'legacy-dm-history-redaction',
      'Legacy DM route stores only message metadata in Operation history, not the full DM body.',
      legacyDmStorageMissing.length === 0,
      { route: 'api/routes/messages.js' },
      legacyDmStorageMissing
    ),
    item(
      'legacy-operation-redaction',
      'Legacy operation status and list routes return sanitized configs instead of raw operation payloads.',
      legacyOperationRedactionMissing.length === 0,
      { route: 'api/routes/operations.js' },
      legacyOperationRedactionMissing
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
  const parsed = parseLiveReadinessEnv(process.env);

  if (!process.env.DATABASE_URL) {
    return {
      checked: false,
      ready: false,
      reason: 'DATABASE_URL is not set; live readiness was not checked.',
      liveCookies: liveCookieSummary(parsed),
      existingSelectors: existingSelectorSummary(parsed),
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
    const readiness = evaluateLiveReadiness({
      env: process.env,
      user,
      activeAccounts,
      smokeUsername,
    });
    return {
      checked: true,
      ...readiness,
      nextAction: readiness.ready
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
