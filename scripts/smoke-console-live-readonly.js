import 'dotenv/config';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const baseUrl = (process.env.XACTIONS_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';
const smokePassword = process.env.XACTIONS_SMOKE_PASSWORD || '';
const smokeToken = process.env.XACTIONS_SMOKE_TOKEN || '';
const profileTarget = String(process.env.XACTIONS_LIVE_PROFILE_TARGET || 'x').replace(/^@/, '').trim();
const smokeId = `live_${Date.now()}_${randomUUID().slice(0, 8)}`;
const accountPrefix = 'smoke_live_readonly_';

const liveCookies = [
  process.env.XACTIONS_LIVE_ACCOUNT_A_COOKIE,
  process.env.XACTIONS_LIVE_ACCOUNT_B_COOKIE,
].map((value) => String(value || '').trim());

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function envBool(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function liveAccountIdsFromEnv() {
  const ids = [
    ...envList('XACTIONS_LIVE_ACCOUNT_IDS'),
    process.env.XACTIONS_LIVE_ACCOUNT_A_ID,
    process.env.XACTIONS_LIVE_ACCOUNT_B_ID,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return [...new Set(ids)];
}

function liveAccountUsernamesFromEnv() {
  const usernames = [
    ...envList('XACTIONS_LIVE_ACCOUNT_USERNAMES'),
    process.env.XACTIONS_LIVE_ACCOUNT_A_USERNAME,
    process.env.XACTIONS_LIVE_ACCOUNT_B_USERNAME,
  ]
    .map((value) => String(value || '').replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(usernames)];
}

function shouldUseExistingAccounts() {
  return liveAccountIdsFromEnv().length > 0
    || liveAccountUsernamesFromEnv().length > 0
    || envBool('XACTIONS_LIVE_USE_EXISTING_ACCOUNTS');
}

const created = {
  accountIds: [],
  scheduleIds: [],
  runIds: [],
  operationIds: [],
  parentOperationIds: [],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function byOr(or) {
  return or.length ? { OR: or } : { id: { in: [] } };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const intervalMs = options.intervalMs || 2500;
  const startedAt = Date.now();
  let lastValue;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (lastValue?.ok) return lastValue;
    await delay(intervalMs);
  }

  throw new Error(`${label} timed out: ${JSON.stringify(lastValue)}`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed with HTTP ${response.status}: ${body?.error || text}`);
  }
  return body;
}

async function resolveSmokeUser() {
  const user = await prisma.user.findUnique({ where: { username: smokeUsername } });
  if (!user) throw new Error(`Smoke user not found: ${smokeUsername}`);
  return user;
}

async function resolveToken(user) {
  if (smokeToken) return smokeToken;
  if (process.env.JWT_SECRET) {
    return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30m' });
  }
  if (!smokePassword) {
    throw new Error('Set JWT_SECRET, XACTIONS_SMOKE_TOKEN, or XACTIONS_SMOKE_PASSWORD.');
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: smokeUsername, password: smokePassword }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    throw new Error(body.error || `Login failed with HTTP ${response.status}`);
  }
  return body.token;
}

async function cleanupSmokeRows(userId, options = {}) {
  const staleBefore = options.stale
    ? new Date(Date.now() - (Number(options.staleHours) || 24) * 60 * 60 * 1000)
    : null;

  const accountWhere = options.stale
    ? {
        userId,
        username: { startsWith: accountPrefix },
        createdAt: { lt: staleBefore },
      }
    : {
        userId,
        ...byOr([
          ...(created.accountIds.length ? [{ id: { in: created.accountIds } }] : []),
          { username: { contains: smokeId } },
        ]),
      };

  const accounts = await prisma.xAccount.findMany({
    where: accountWhere,
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);

  const schedules = await prisma.scheduledAction.findMany({
    where: {
      userId,
      ...byOr([
        ...(created.scheduleIds.length ? [{ id: { in: created.scheduleIds } }] : []),
        ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
        { name: { contains: smokeId } },
      ]),
    },
    select: { id: true },
  });
  const scheduleIds = schedules.map((schedule) => schedule.id);

  const explicitOperationIds = [...created.operationIds, ...created.parentOperationIds];
  const operations = await prisma.operation.findMany({
    where: {
      userId,
      ...byOr([
        ...(explicitOperationIds.length ? [{ id: { in: explicitOperationIds } }] : []),
        ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
        ...(scheduleIds.length ? [{ scheduledActionId: { in: scheduleIds } }] : []),
        { config: { contains: smokeId } },
      ]),
    },
    select: { id: true, parentOperationId: true },
  });
  const operationIds = [
    ...new Set(operations.flatMap((operation) => [operation.id, operation.parentOperationId]).filter(Boolean)),
  ];

  await prisma.scheduledActionRun.deleteMany({
    where: {
      ...byOr([
        ...(created.runIds.length ? [{ id: { in: created.runIds } }] : []),
        ...(scheduleIds.length ? [{ scheduledActionId: { in: scheduleIds } }] : []),
        ...(operationIds.length ? [{ operationId: { in: operationIds } }] : []),
      ]),
    },
  });
  if (operationIds.length) await prisma.operation.deleteMany({ where: { id: { in: operationIds } } });
  if (scheduleIds.length) await prisma.scheduledAction.deleteMany({ where: { id: { in: scheduleIds } } });
  if (accountIds.length) await prisma.xAccount.deleteMany({ where: { id: { in: accountIds } } });

  return {
    accounts: accountIds.length,
    schedules: scheduleIds.length,
    operations: operationIds.length,
  };
}

async function createCookieBackedAccounts(token) {
  assert(
    liveCookies.every(Boolean),
    'Set XACTIONS_LIVE_ACCOUNT_A_COOKIE and XACTIONS_LIVE_ACCOUNT_B_COOKIE, or use existing accounts with XACTIONS_LIVE_ACCOUNT_IDS, XACTIONS_LIVE_ACCOUNT_USERNAMES, or XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true.'
  );
  assert(liveCookies[0] !== liveCookies[1], 'Use two different X session cookies for live multi-account smoke.');
  assert(profileTarget, 'Set XACTIONS_LIVE_PROFILE_TARGET or use the default target.');

  const accounts = [];
  for (const [index, sessionCookie] of liveCookies.entries()) {
    const username = `${accountPrefix}${index + 1}_${smokeId}`;
    const response = await requestJson('/api/accounts', {
      method: 'POST',
      token,
      body: {
        username,
        displayName: `Live Smoke ${index + 1}`,
        sessionCookie,
        isDefault: false,
      },
    });
    assert(response.account?.id, `Account ${index + 1} was not created.`);
    assert(response.account.status === 'active', `Account ${index + 1} is not active after verification.`);
    accounts.push(response.account);
    created.accountIds.push(response.account.id);
  }
  return {
    source: 'temporary-cookies',
    cleanupAccounts: true,
    accounts,
  };
}

async function resolveExistingAccounts(user) {
  const accountIds = liveAccountIdsFromEnv();
  const usernames = liveAccountUsernamesFromEnv();
  const useFirstActive = envBool('XACTIONS_LIVE_USE_EXISTING_ACCOUNTS');
  const selectorCount = [accountIds.length > 0, usernames.length > 0, useFirstActive].filter(Boolean).length;

  assert(selectorCount === 1, 'Use exactly one existing-account selector: XACTIONS_LIVE_ACCOUNT_IDS, XACTIONS_LIVE_ACCOUNT_USERNAMES, or XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true.');
  assert(profileTarget, 'Set XACTIONS_LIVE_PROFILE_TARGET or use the default target.');

  const select = {
    id: true,
    username: true,
    status: true,
    lastVerifiedAt: true,
  };
  let source = 'existing-accounts';
  let orderedAccounts = [];

  if (accountIds.length > 0) {
    assert(
      accountIds.length === 2,
      `Set exactly two existing XAccount IDs. Received ${accountIds.length}. Use XACTIONS_LIVE_ACCOUNT_IDS="id1,id2" or XACTIONS_LIVE_ACCOUNT_A_ID / XACTIONS_LIVE_ACCOUNT_B_ID.`
    );

    const accounts = await prisma.xAccount.findMany({
      where: {
        userId: user.id,
        id: { in: accountIds },
      },
      select,
    });
    const byId = new Map(accounts.map((account) => [account.id, account]));
    orderedAccounts = accountIds.map((id) => byId.get(id));
    const missingIds = accountIds.filter((id, index) => !orderedAccounts[index]);
    assert(!missingIds.length, `Existing XAccount IDs were not found for ${smokeUsername}: ${missingIds.join(', ')}`);
    source = 'existing-account-ids';
  } else if (usernames.length > 0) {
    assert(
      usernames.length === 2,
      `Set exactly two existing XAccount usernames. Received ${usernames.length}. Use XACTIONS_LIVE_ACCOUNT_USERNAMES="account_a,account_b" or XACTIONS_LIVE_ACCOUNT_A_USERNAME / XACTIONS_LIVE_ACCOUNT_B_USERNAME.`
    );

    const accounts = await prisma.xAccount.findMany({
      where: { userId: user.id },
      select,
    });
    const byUsername = new Map(accounts.map((account) => [String(account.username || '').toLowerCase(), account]));
    orderedAccounts = usernames.map((username) => byUsername.get(username));
    const missingUsernames = usernames.filter((username, index) => !orderedAccounts[index]);
    assert(!missingUsernames.length, `Existing XAccount usernames were not found for ${smokeUsername}: ${missingUsernames.join(', ')}`);
    source = 'existing-account-usernames';
  } else {
    orderedAccounts = await prisma.xAccount.findMany({
      where: {
        userId: user.id,
        status: 'active',
      },
      select,
      orderBy: [
        { isDefault: 'desc' },
        { updatedAt: 'desc' },
      ],
      take: 2,
    });
    assert(orderedAccounts.length === 2, `XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true requires at least two active XAccounts. Found ${orderedAccounts.length}.`);
    source = 'existing-active-accounts';
  }

  const unavailable = orderedAccounts.filter((account) => account.status !== 'active');
  assert(!unavailable.length, `Existing XAccounts must be active: ${unavailable.map((account) => account.id).join(', ')}`);

  return {
    source,
    cleanupAccounts: false,
    accounts: orderedAccounts,
  };
}

async function resolveLiveAccounts(user, token) {
  if (shouldUseExistingAccounts()) {
    return resolveExistingAccounts(user);
  }
  return createCookieBackedAccounts(token);
}

async function pollOperations(operationIds, label) {
  const result = await waitFor(label, async () => {
    const operations = await prisma.operation.findMany({
      where: { id: { in: operationIds } },
      select: {
        id: true,
        accountId: true,
        status: true,
        error: true,
        result: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ok: operations.length === operationIds.length
        && operations.every((operation) => ['completed', 'failed', 'cancelled'].includes(operation.status)),
      operations,
    };
  });

  const failed = result.operations.filter((operation) => operation.status !== 'completed');
  assert(!failed.length, `${label} had non-completed operations: ${JSON.stringify(failed)}`);
  return result.operations;
}

async function pollScheduledRuns(runIds) {
  const result = await waitFor('live scheduled run completion', async () => {
    const runs = await prisma.scheduledActionRun.findMany({
      where: { id: { in: runIds } },
      include: {
        operation: {
          select: {
            id: true,
            accountId: true,
            status: true,
            error: true,
            result: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ok: runs.length === runIds.length
        && runs.every((run) => ['completed', 'failed', 'skipped'].includes(run.status)),
      runs,
    };
  });

  const failed = result.runs.filter((run) => run.status !== 'completed' || run.operation?.status !== 'completed');
  assert(!failed.length, `Live scheduled runs did not complete cleanly: ${JSON.stringify(failed)}`);
  return result.runs;
}

async function deleteAccounts(token, accounts) {
  const deleted = [];
  for (const account of accounts) {
    const response = await requestJson(`/api/accounts/${account.id}`, {
      method: 'DELETE',
      token,
    });
    assert(response.deleted === true, `DELETE /api/accounts/${account.id} did not confirm deletion.`);
    deleted.push({ id: account.id, deleted: true });
  }
  return deleted;
}

async function assertNoCurrentResidue(userId) {
  const [accounts, schedules, operations, runs] = await Promise.all([
    prisma.xAccount.count({ where: { userId, id: { in: created.accountIds } } }),
    prisma.scheduledAction.count({ where: { userId, id: { in: created.scheduleIds } } }),
    prisma.operation.count({
      where: { userId, id: { in: [...created.operationIds, ...created.parentOperationIds] } },
    }),
    prisma.scheduledActionRun.count({ where: { id: { in: created.runIds } } }),
  ]);
  assert(accounts === 0 && schedules === 0 && operations === 0 && runs === 0, `Cleanup residue remains: ${JSON.stringify({
    accounts,
    schedules,
    operations,
    runs,
  })}`);
}

async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required.');

  const user = await resolveSmokeUser();
  const token = await resolveToken(user);
  const staleCleanup = await cleanupSmokeRows(user.id, { stale: true, staleHours: 24 });
  const liveAccounts = await resolveLiveAccounts(user, token);
  const accounts = liveAccounts.accounts;
  const accountIds = accounts.map((account) => account.id);

  const executeResponse = await requestJson('/api/console/actions/execute', {
    method: 'POST',
    token,
    body: {
      featureId: 'profile',
      mode: 'live',
      accountIds,
      config: { username: profileTarget },
    },
  });
  const childOperationIds = (executeResponse.operations || []).map((operation) => operation.operationId);
  assert(executeResponse.parentOperationId, 'Live multi-account execute did not create a parent operation.');
  assert(childOperationIds.length === 2, `Expected 2 live child operations, got ${childOperationIds.length}.`);
  created.parentOperationIds.push(executeResponse.parentOperationId);
  created.operationIds.push(...childOperationIds);

  const liveOperations = await pollOperations(childOperationIds, 'live multi-account profile execution');

  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduleResponse = await requestJson('/api/console/actions/schedule', {
    method: 'POST',
    token,
    body: {
      featureId: 'profile',
      mode: 'live',
      name: `Live readonly smoke ${smokeId}`,
      accountIds,
      maxRetries: 0,
      config: { username: profileTarget },
      schedule: {
        type: 'once',
        runAt,
        timezone: 'Asia/Tokyo',
      },
    },
  });

  const schedules = scheduleResponse.schedules || [];
  assert(schedules.length === 2, `Expected 2 live schedules, got ${schedules.length}.`);
  created.scheduleIds.push(...schedules.map((schedule) => schedule.id));

  const runNowResponses = [];
  for (const schedule of schedules) {
    const runNow = await requestJson(`/api/scheduled-actions/${schedule.id}/run-now`, {
      method: 'POST',
      token,
    });
    assert(runNow.status === 'queued', `Live schedule ${schedule.id} was not queued: ${JSON.stringify(runNow)}`);
    created.runIds.push(runNow.runId);
    created.operationIds.push(runNow.operationId);
    runNowResponses.push({ scheduleId: schedule.id, accountId: schedule.accountId, ...runNow });
  }

  const scheduledRuns = await pollScheduledRuns(created.runIds);

  const historyResponse = await requestJson(
    `/api/console/history?featureId=profile&accountIds=${encodeURIComponent(accountIds.join(','))}&limit=20`,
    { token }
  );
  const historyIds = new Set((historyResponse.operations || []).flatMap((operation) => [
    operation.id,
    ...(operation.childOperations || []).map((child) => child.id),
  ]));
  assert(historyIds.has(executeResponse.parentOperationId), 'Live parent operation was not visible in filtered history.');
  assert(childOperationIds.every((operationId) => historyIds.has(operationId)), 'Live child operations were not visible in filtered history.');
  assert(runNowResponses.every((runNow) => historyIds.has(runNow.operationId)), 'Live scheduled operations were not visible in filtered history.');

  const accountDeletes = liveAccounts.cleanupAccounts
    ? await deleteAccounts(token, accounts)
    : [];

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    smokeId,
    accountSource: liveAccounts.source,
    profileTarget,
    staleCleanup,
    accounts: accounts.map((account) => ({
      id: account.id,
      username: liveAccounts.cleanupAccounts ? account.username : undefined,
      status: account.status,
      verified: !!account.lastVerifiedAt,
    })),
    immediate: {
      parentOperationId: executeResponse.parentOperationId,
      operations: liveOperations.map((operation) => ({
        id: operation.id,
        accountId: operation.accountId,
        status: operation.status,
      })),
    },
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      accountId: schedule.accountId,
      mode: schedule.mode,
      status: schedule.status,
    })),
    scheduledRuns: scheduledRuns.map((run) => ({
      id: run.id,
      scheduleId: run.scheduledActionId,
      operationId: run.operationId,
      accountId: run.operation?.accountId,
      status: run.status,
      operationStatus: run.operation?.status,
    })),
    historyCount: historyResponse.operations?.length || 0,
    accountDeletes,
  }, null, 2));
}

try {
  await main();
} finally {
  try {
    const user = await prisma.user.findUnique({
      where: { username: smokeUsername },
      select: { id: true },
    });
    if (user) {
      await cleanupSmokeRows(user.id);
      await assertNoCurrentResidue(user.id);
    }
  } finally {
    await prisma.$disconnect();
  }
}
