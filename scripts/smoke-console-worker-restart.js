import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../api/services/sessionCrypto.js';

const prisma = new PrismaClient();

const command = process.argv[2] || 'verify';
const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';
const accountPrefix = 'smoke_console_restart_';
const smokeId = process.env.XACTIONS_WORKER_RESTART_SMOKE_ID
  || process.argv[3]
  || `restart_${Date.now()}_${randomUUID().slice(0, 8)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

async function resolveSmokeUser() {
  const user = await prisma.user.findUnique({
    where: { username: smokeUsername },
  });
  if (!user) throw new Error(`Smoke user not found: ${smokeUsername}`);
  return user;
}

async function cleanupBySmokeId(userId, targetSmokeId) {
  if (!targetSmokeId) {
    return { accounts: 0, schedules: 0, operations: 0, runs: 0 };
  }

  const accounts = await prisma.xAccount.findMany({
    where: {
      userId,
      username: { contains: targetSmokeId },
    },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);

  const schedules = await prisma.scheduledAction.findMany({
    where: {
      userId,
      OR: [
        { name: { contains: targetSmokeId } },
        ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
      ],
    },
    select: { id: true },
  });
  const scheduleIds = schedules.map((schedule) => schedule.id);

  const operations = await prisma.operation.findMany({
    where: {
      userId,
      OR: [
        { config: { contains: targetSmokeId } },
        ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
        ...(scheduleIds.length ? [{ scheduledActionId: { in: scheduleIds } }] : []),
      ],
    },
    select: { id: true },
  });
  const operationIds = operations.map((operation) => operation.id);

  const runsDelete = await prisma.scheduledActionRun.deleteMany({
    where: {
      OR: [
        ...(scheduleIds.length ? [{ scheduledActionId: { in: scheduleIds } }] : []),
        ...(operationIds.length ? [{ operationId: { in: operationIds } }] : []),
      ],
    },
  });
  const operationsDelete = operationIds.length
    ? await prisma.operation.deleteMany({ where: { id: { in: operationIds } } })
    : { count: 0 };
  const schedulesDelete = scheduleIds.length
    ? await prisma.scheduledAction.deleteMany({ where: { id: { in: scheduleIds } } })
    : { count: 0 };
  const accountsDelete = accountIds.length
    ? await prisma.xAccount.deleteMany({ where: { id: { in: accountIds } } })
    : { count: 0 };

  return {
    accounts: accountsDelete.count,
    schedules: schedulesDelete.count,
    operations: operationsDelete.count,
    runs: runsDelete.count,
  };
}

async function cleanupStale(userId) {
  const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const staleAccounts = await prisma.xAccount.findMany({
    where: {
      userId,
      username: { startsWith: accountPrefix },
      createdAt: { lt: staleBefore },
    },
    select: { username: true },
  });

  let totals = { accounts: 0, schedules: 0, operations: 0, runs: 0 };
  for (const account of staleAccounts) {
    const targetSmokeId = account.username.slice(accountPrefix.length);
    const cleanup = await cleanupBySmokeId(userId, targetSmokeId);
    totals = {
      accounts: totals.accounts + cleanup.accounts,
      schedules: totals.schedules + cleanup.schedules,
      operations: totals.operations + cleanup.operations,
      runs: totals.runs + cleanup.runs,
    };
  }

  return totals;
}

async function prepare() {
  const user = await resolveSmokeUser();
  const staleCleanup = await cleanupStale(user.id);
  await cleanupBySmokeId(user.id, smokeId);

  const now = new Date();
  const dueAt = new Date(now.getTime() - 15 * 1000);
  const text = `[${smokeId}] worker restart recovery dry run`;

  const account = await prisma.xAccount.create({
    data: {
      userId: user.id,
      username: `${accountPrefix}${smokeId}`,
      displayName: 'Smoke Worker Restart',
      encryptedCookie: encrypt(`auth_token=${smokeId}; ct0=${smokeId}`),
      status: 'active',
      isDefault: false,
      lastVerifiedAt: now,
    },
  });

  const schedule = await prisma.scheduledAction.create({
    data: {
      userId: user.id,
      accountId: account.id,
      name: `Worker restart recovery ${smokeId}`,
      featureId: 'postTweet',
      operationType: 'postTweet',
      config: encrypt(JSON.stringify({ text })),
      mode: 'dryRun',
      scheduleType: 'once',
      runAt: dueAt,
      timezone: 'Asia/Tokyo',
      status: 'active',
      nextRunAt: dueAt,
      maxRetries: 0,
    },
  });

  printJson({
    ok: true,
    phase: 'prepare',
    smokeId,
    smokeUsername,
    accountId: account.id,
    scheduleId: schedule.id,
    dueAt: dueAt.toISOString(),
    staleCleanup,
  });
}

async function findSchedule(userId) {
  return prisma.scheduledAction.findFirst({
    where: {
      userId,
      name: { contains: smokeId },
    },
    include: {
      account: true,
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          operation: true,
        },
      },
    },
  });
}

async function verify() {
  const user = await resolveSmokeUser();
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < 90 * 1000) {
    const schedule = await findSchedule(user.id);
    const run = schedule?.runs?.[0] || null;
    const operation = run?.operation || null;
    last = {
      scheduleStatus: schedule?.status || null,
      nextRunAt: schedule?.nextRunAt || null,
      lockedAt: schedule?.lockedAt || null,
      lockedBy: schedule?.lockedBy || null,
      runStatus: run?.status || null,
      operationStatus: operation?.status || null,
      operationId: operation?.id || null,
    };

    if (
      schedule?.status === 'completed'
      && schedule.nextRunAt === null
      && schedule.lockedAt === null
      && schedule.lockedBy === null
      && run?.status === 'completed'
      && operation?.status === 'completed'
    ) {
      const result = operation.result ? JSON.parse(operation.result) : {};
      assert(result.dryRun === true, 'Restart recovery operation did not run in dry-run mode.');
      printJson({
        ok: true,
        phase: 'verify',
        smokeId,
        scheduleId: schedule.id,
        accountId: schedule.accountId,
        runId: run.id,
        operationId: operation.id,
        result,
      });
      return;
    }

    await delay(1500);
  }

  throw new Error(`Worker restart recovery timed out: ${JSON.stringify(last)}`);
}

async function cleanup() {
  const user = await resolveSmokeUser();
  const cleanup = await cleanupBySmokeId(user.id, smokeId);
  printJson({
    ok: true,
    phase: 'cleanup',
    smokeId,
    cleanup,
  });
}

try {
  if (command === 'prepare') {
    await prepare();
  } else if (command === 'verify') {
    await verify();
  } else if (command === 'cleanup') {
    await cleanup();
  } else {
    throw new Error('Usage: node scripts/smoke-console-worker-restart.js prepare|verify|cleanup');
  }
} finally {
  await prisma.$disconnect();
}
