import 'dotenv/config';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../api/services/sessionCrypto.js';

const prisma = new PrismaClient();

const baseUrl = (process.env.XACTIONS_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';
const smokePassword = process.env.XACTIONS_SMOKE_PASSWORD || '';
const smokeToken = process.env.XACTIONS_SMOKE_TOKEN || '';
const smokeId = `smoke_${Date.now()}_${randomUUID().slice(0, 8)}`;
const accountPrefix = 'smoke_console_scheduler_';

const created = {
  accountIds: [],
  scheduleIds: [],
  runIds: [],
  operationIds: [],
  parentOperationIds: [],
};

function byOr(or) {
  return or.length ? { OR: or } : { id: { in: [] } };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const intervalMs = options.intervalMs || 1000;
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
  const user = await prisma.user.findUnique({
    where: { username: smokeUsername },
  });
  if (!user) {
    throw new Error(`Smoke user not found: ${smokeUsername}`);
  }
  return user;
}

async function resolveToken(user) {
  if (smokeToken) return smokeToken;
  if (process.env.JWT_SECRET) {
    return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '20m' });
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

  const scheduleWhere = {
    userId,
    ...byOr([
      ...(created.scheduleIds.length ? [{ id: { in: created.scheduleIds } }] : []),
      ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
      { name: { contains: smokeId } },
    ]),
  };
  const schedules = await prisma.scheduledAction.findMany({
    where: scheduleWhere,
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
  if (operationIds.length) {
    await prisma.operation.deleteMany({
      where: {
        id: { in: operationIds },
      },
    });
  }
  if (scheduleIds.length) {
    await prisma.scheduledAction.deleteMany({
      where: {
        id: { in: scheduleIds },
      },
    });
  }
  if (accountIds.length) {
    await prisma.xAccount.deleteMany({
      where: {
        id: { in: accountIds },
      },
    });
  }

  return {
    accounts: accountIds.length,
    schedules: scheduleIds.length,
    operations: operationIds.length,
  };
}

async function exerciseAccountApi(token, accounts) {
  const updatedDisplayName = `Smoke Primary ${smokeId}`;
  const patchResponse = await requestJson(`/api/accounts/${accounts[0].id}`, {
    method: 'PATCH',
    token,
    body: { displayName: updatedDisplayName },
  });
  assert(patchResponse.account?.displayName === updatedDisplayName, 'PATCH /api/accounts/:id did not update displayName.');

  const defaultResponse = await requestJson(`/api/accounts/${accounts[1].id}/default`, {
    method: 'POST',
    token,
  });
  assert(defaultResponse.account?.id === accounts[1].id, 'POST /api/accounts/:id/default returned the wrong account.');
  assert(defaultResponse.account?.isDefault === true, 'POST /api/accounts/:id/default did not mark the account as default.');

  const listResponse = await requestJson('/api/accounts', { token });
  assert(
    listResponse.defaultAccountId === accounts[1].id,
    'GET /api/accounts did not expose the updated default account.'
  );

  return {
    patchedAccountId: accounts[0].id,
    patchedDisplayName: patchResponse.account.displayName,
    defaultAccountId: listResponse.defaultAccountId,
  };
}

async function exerciseAccountDeleteApi(token, accounts) {
  const results = [];
  for (const account of accounts) {
    const response = await requestJson(`/api/accounts/${account.id}`, {
      method: 'DELETE',
      token,
    });
    assert(response.deleted === true, `DELETE /api/accounts/${account.id} did not confirm deletion.`);
    results.push({ id: account.id, deleted: response.deleted });
  }
  return results;
}

async function createSmokeAccounts(userId) {
  const usernames = [`${accountPrefix}a_${smokeId}`, `${accountPrefix}b_${smokeId}`];
  const accounts = [];

  for (const [index, username] of usernames.entries()) {
    const account = await prisma.xAccount.create({
      data: {
        userId,
        username,
        displayName: `Smoke Account ${index + 1}`,
        encryptedCookie: encrypt(`auth_token=${smokeId}_${index}; ct0=${smokeId}_csrf_${index}`),
        authMethod: 'session',
        status: 'active',
        isDefault: false,
        lastVerifiedAt: new Date(),
      },
      select: {
        id: true,
        username: true,
      },
    });
    accounts.push(account);
    created.accountIds.push(account.id);
  }

  return accounts;
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
    const statuses = Object.fromEntries(operations.map((operation) => [operation.id, operation.status]));
    const terminal = operations.length === operationIds.length
      && operations.every((operation) => ['completed', 'failed', 'cancelled'].includes(operation.status));
    return { ok: terminal, operations, statuses };
  }, { timeoutMs: 90000, intervalMs: 1500 });

  const failed = result.operations.filter((operation) => operation.status !== 'completed');
  assert(!failed.length, `${label} had non-completed operations: ${JSON.stringify(failed)}`);
  return result.operations;
}

async function pollScheduledRuns(runIds) {
  const result = await waitFor('scheduled run completion', async () => {
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
    const terminal = runs.length === runIds.length
      && runs.every((run) => ['completed', 'failed', 'skipped'].includes(run.status));
    return { ok: terminal, runs };
  }, { timeoutMs: 90000, intervalMs: 1500 });

  const failed = result.runs.filter((run) => run.status !== 'completed' || run.operation?.status !== 'completed');
  assert(!failed.length, `Scheduled runs did not complete cleanly: ${JSON.stringify(failed)}`);
  return result.runs;
}

async function assertNoCurrentResidue(userId) {
  const [accounts, schedules, operations, runs] = await Promise.all([
    prisma.xAccount.count({
      where: {
        userId,
        id: { in: created.accountIds },
      },
    }),
    prisma.scheduledAction.count({
      where: {
        userId,
        id: { in: created.scheduleIds },
      },
    }),
    prisma.operation.count({
      where: {
        userId,
        id: { in: [...created.operationIds, ...created.parentOperationIds] },
      },
    }),
    prisma.scheduledActionRun.count({
      where: {
        id: { in: created.runIds },
      },
    }),
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
  const accounts = await createSmokeAccounts(user.id);
  const accountIds = accounts.map((account) => account.id);

  const accountsResponse = await requestJson('/api/console/accounts', { token });
  assert(
    accountIds.every((accountId) => accountsResponse.accounts.some((account) => account.id === accountId)),
    'Temporary accounts are not visible from /api/console/accounts.'
  );
  const accountApi = await exerciseAccountApi(token, accounts);

  const executeResponse = await requestJson('/api/console/actions/execute', {
    method: 'POST',
    token,
    body: {
      featureId: 'postTweet',
      mode: 'dryRun',
      accountIds,
      config: {
        text: `[${smokeId}] immediate multi-account dry run`,
      },
    },
  });

  const childOperationIds = (executeResponse.operations || []).map((operation) => operation.operationId);
  assert(executeResponse.parentOperationId, 'Multi-account execute did not create a parent operation.');
  assert(childOperationIds.length === 2, `Expected 2 child operations, got ${childOperationIds.length}.`);
  created.parentOperationIds.push(executeResponse.parentOperationId);
  created.operationIds.push(...childOperationIds);

  const immediateOperations = await pollOperations(childOperationIds, 'immediate multi-account execution');
  const parent = await waitFor('parent operation completion', async () => {
    const operation = await prisma.operation.findUnique({
      where: { id: executeResponse.parentOperationId },
      select: { id: true, status: true, error: true },
    });
    return {
      ok: operation?.status === 'completed',
      operation,
    };
  }, { timeoutMs: 45000, intervalMs: 1000 });

  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduleResponse = await requestJson('/api/console/actions/schedule', {
    method: 'POST',
    token,
    body: {
      featureId: 'postTweet',
      mode: 'dryRun',
      name: `Console scheduler smoke ${smokeId}`,
      accountIds,
      maxRetries: 0,
      config: {
        text: `[${smokeId}] scheduled multi-account dry run`,
      },
      schedule: {
        type: 'once',
        runAt,
        timezone: 'Asia/Tokyo',
      },
    },
  });

  const schedules = scheduleResponse.schedules || [];
  assert(schedules.length === 2, `Expected 2 schedules, got ${schedules.length}.`);
  assert(
    accountIds.every((accountId) => schedules.some((schedule) => schedule.accountId === accountId)),
    'Schedules were not created for both accounts.'
  );
  created.scheduleIds.push(...schedules.map((schedule) => schedule.id));

  const scheduleList = await requestJson(
    `/api/scheduled-actions?featureId=postTweet&accountIds=${encodeURIComponent(accountIds.join(','))}&limit=20`,
    { token }
  );
  assert(
    created.scheduleIds.every((scheduleId) => scheduleList.schedules.some((schedule) => schedule.id === scheduleId)),
    'Created schedules are not visible from the account-filtered schedule list.'
  );

  const runNowResponses = [];
  for (const schedule of schedules) {
    const runNow = await requestJson(`/api/scheduled-actions/${schedule.id}/run-now`, {
      method: 'POST',
      token,
    });
    assert(runNow.status === 'queued', `Schedule ${schedule.id} was not queued: ${JSON.stringify(runNow)}`);
    assert(runNow.runId && runNow.operationId, `Schedule ${schedule.id} did not return run and operation IDs.`);
    runNowResponses.push({ scheduleId: schedule.id, accountId: schedule.accountId, ...runNow });
    created.runIds.push(runNow.runId);
    created.operationIds.push(runNow.operationId);
  }

  const scheduledRuns = await pollScheduledRuns(created.runIds);

  for (const runNow of runNowResponses) {
    const runsResponse = await requestJson(`/api/scheduled-actions/${runNow.scheduleId}/runs?limit=5`, { token });
    const publicRun = runsResponse.runs.find((run) => run.id === runNow.runId);
    assert(publicRun, `Run ${runNow.runId} was not visible from the public run history.`);
    assert(publicRun.status === 'completed', `Run ${runNow.runId} was not completed in public history.`);
    assert(publicRun.operation?.accountId === runNow.accountId, `Run ${runNow.runId} did not expose the expected account.`);
  }

  const historyResponse = await requestJson(
    `/api/console/history?featureId=postTweet&accountIds=${encodeURIComponent(accountIds.join(','))}&limit=20`,
    { token }
  );
  const historyOperations = historyResponse.operations || [];
  const historyIds = new Set(historyOperations.flatMap((operation) => [
    operation.id,
    ...(operation.childOperations || []).map((child) => child.id),
  ]));
  assert(historyIds.has(executeResponse.parentOperationId), 'Immediate parent operation was not visible in filtered history.');
  assert(childOperationIds.every((operationId) => historyIds.has(operationId)), 'Immediate child operations were not visible in filtered history.');
  assert(
    runNowResponses.every((runNow) => historyIds.has(runNow.operationId)),
    'Scheduled run operations were not visible in filtered history.'
  );
  const accountDeletes = await exerciseAccountDeleteApi(token, accounts);

  const summary = {
    ok: true,
    baseUrl,
    smokeId,
    staleCleanup,
    accounts: accounts.map((account) => ({ id: account.id, username: account.username })),
    accountApi: {
      ...accountApi,
      deletes: accountDeletes,
    },
    immediate: {
      parentOperationId: executeResponse.parentOperationId,
      parentStatus: parent.operation.status,
      operations: immediateOperations.map((operation) => ({
        id: operation.id,
        accountId: operation.accountId,
        status: operation.status,
      })),
    },
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      accountId: schedule.accountId,
      status: schedule.status,
      nextRunAt: schedule.nextRunAt,
    })),
    scheduledRuns: scheduledRuns.map((run) => ({
      id: run.id,
      scheduleId: run.scheduledActionId,
      operationId: run.operationId,
      accountId: run.operation?.accountId,
      status: run.status,
      operationStatus: run.operation?.status,
    })),
    historyCount: historyOperations.length,
  };

  console.log(JSON.stringify(summary, null, 2));
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
