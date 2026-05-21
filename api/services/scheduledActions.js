import os from 'os';
import { PrismaClient } from '@prisma/client';
import { getFeatureById } from '../config/features.js';
import {
  createActionPayload,
  parseJson,
  sanitizeConfig,
} from './consoleActions.js';
import {
  getAccountForUser,
  getDecryptedAccountCookie,
  listAccountsForUser,
  sanitizeAccount,
} from './accountStore.js';
import { decrypt, encrypt } from './sessionCrypto.js';
import { calculateNextRunAt, normalizeScheduleInput } from './scheduleUtils.js';

const prisma = new PrismaClient();
const schedulerId = `${os.hostname()}-${process.pid}`;
let schedulerTimer = null;
let schedulerRunning = false;

function decryptScheduledConfig(schedule) {
  const decrypted = decrypt(schedule.config);
  if (!decrypted) return {};
  return parseJson(decrypted) || {};
}

function publicSchedule(schedule, includeConfig = true) {
  const config = includeConfig ? sanitizeConfig(decryptScheduledConfig(schedule)) : undefined;
  return {
    id: schedule.id,
    userId: schedule.userId,
    accountId: schedule.accountId,
    account: schedule.account ? sanitizeAccount(schedule.account) : null,
    name: schedule.name,
    featureId: schedule.featureId,
    operationType: schedule.operationType,
    mode: schedule.mode,
    config,
    scheduleType: schedule.scheduleType,
    cron: schedule.cron,
    intervalMinutes: schedule.intervalMinutes,
    runAt: schedule.runAt,
    daysOfWeek: schedule.daysOfWeek,
    timezone: schedule.timezone,
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    failureCount: schedule.failureCount,
    maxRetries: schedule.maxRetries,
    lastError: schedule.lastError,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function validateFeatureForSchedule(feature, mode) {
  if (!feature) throw new Error('機能が見つかりません。');
  if (feature.status !== 'available' || !feature.consoleAction) {
    throw new Error('この機能はまだ予約実行に対応していません。');
  }
  if (!feature.supportsSchedule) {
    throw new Error('この機能は予約実行に対応していません。');
  }
  if (mode === 'dryRun' && !feature.supportsDryRun) {
    throw new Error('この機能は確認のみには対応していません。実行を選んでください。');
  }
}

async function skipScheduledAction(schedule, scheduledFor, message, options = {}) {
  const run = await prisma.scheduledActionRun.create({
    data: {
      scheduledActionId: schedule.id,
      status: 'skipped',
      scheduledFor,
      finishedAt: new Date(),
      error: message,
    },
  });

  if (options.advanceSchedule !== false) {
    await prisma.scheduledAction.update({
      where: { id: schedule.id },
      data: {
        status: 'paused',
        lockedAt: null,
        lockedBy: null,
        lastError: message,
      },
    }).catch(() => {});
  }

  return { runId: run.id, operationId: null, skipped: true, error: message };
}

async function resolveAccountIds(user, feature, body) {
  if (!feature.accountRequired) return [null];

  const accounts = await listAccountsForUser(user);
  const requested = Array.isArray(body.accountIds)
    ? body.accountIds
    : [body.accountId || accounts.find((account) => account.isDefault)?.id || accounts[0]?.id].filter(Boolean);

  if (!requested.length) {
    throw new Error('Xアカウントを追加してください。');
  }

  const allowed = new Map(accounts.map((account) => [account.id, account]));
  for (const accountId of requested) {
    const account = allowed.get(accountId);
    if (!account) throw new Error('選択したXアカウントが見つかりません。');
    if (account.status !== 'active') throw new Error(`@${account.username} は実行できる状態ではありません。`);
  }

  return [...new Set(requested)];
}

async function createSchedulesFromRequest(user, body) {
  const feature = getFeatureById(body.featureId);
  const mode = body.mode === 'live' ? 'live' : 'dryRun';
  validateFeatureForSchedule(feature, mode);

  const config = body.config || {};
  const payload = createActionPayload(feature, config, mode, user);
  const scheduleInput = normalizeScheduleInput(body.schedule || {});
  const nextRunAt = calculateNextRunAt(scheduleInput);
  const accountIds = await resolveAccountIds(user, feature, body);
  const encryptedConfig = encrypt(JSON.stringify(config));
  const maxRetries = Math.min(Math.max(Number(body.maxRetries) || 2, 0), 5);
  const name = String(body.name || feature.title || feature.id).trim().slice(0, 80);

  const schedules = [];
  for (const accountId of accountIds) {
    if (accountId) {
      const account = await getAccountForUser(user.id, accountId);
      if (!account) throw new Error('選択したXアカウントが見つかりません。');
    }

    const schedule = await prisma.scheduledAction.create({
      data: {
        userId: user.id,
        accountId,
        name,
        featureId: feature.id,
        operationType: payload.operationType,
        config: encryptedConfig,
        mode,
        scheduleType: scheduleInput.scheduleType,
        cron: scheduleInput.cron,
        intervalMinutes: scheduleInput.intervalMinutes,
        runAt: scheduleInput.runAt,
        daysOfWeek: scheduleInput.daysOfWeek,
        timezone: scheduleInput.timezone,
        status: 'active',
        nextRunAt,
        maxRetries,
      },
      include: { account: true },
    });
    schedules.push(publicSchedule(schedule));
  }

  return schedules;
}

async function enqueueScheduledAction(schedule, queueJobFn, options = {}) {
  const fullSchedule = schedule.user
    ? schedule
    : await prisma.scheduledAction.findUnique({
        where: { id: schedule.id },
        include: { user: true, account: true },
      });

  if (!fullSchedule) throw new Error('予約が見つかりません。');
  const feature = getFeatureById(fullSchedule.featureId);
  validateFeatureForSchedule(feature, fullSchedule.mode);

  const config = decryptScheduledConfig(fullSchedule);
  const payload = createActionPayload(feature, config, fullSchedule.mode, fullSchedule.user);
  const scheduledFor = options.scheduledFor || fullSchedule.nextRunAt || new Date();

  if (fullSchedule.accountId) {
    if (!fullSchedule.account || fullSchedule.account.status !== 'active') {
      const username = fullSchedule.account?.username ? `@${fullSchedule.account.username}` : '選択したXアカウント';
      return skipScheduledAction(
        fullSchedule,
        scheduledFor,
        `${username} は実行できる状態ではありません。`,
        options
      );
    }

    const cookie = await getDecryptedAccountCookie(fullSchedule.userId, fullSchedule.accountId);
    if (!cookie) {
      return skipScheduledAction(
        fullSchedule,
        scheduledFor,
        `@${fullSchedule.account.username} のX連携情報を取得できませんでした。`,
        options
      );
    }
  }

  const run = await prisma.scheduledActionRun.create({
    data: {
      scheduledActionId: fullSchedule.id,
      status: 'queued',
      scheduledFor,
    },
  });

  try {
    const operation = await prisma.operation.create({
      data: {
        userId: fullSchedule.userId,
        accountId: fullSchedule.accountId,
        scheduledActionId: fullSchedule.id,
        type: payload.operationType,
        status: 'pending',
        config: JSON.stringify({
          ...payload.operationConfig,
          scheduledActionId: fullSchedule.id,
          scheduledActionRunId: run.id,
        }),
      },
    });

    await prisma.scheduledActionRun.update({
      where: { id: run.id },
      data: { operationId: operation.id },
    });

    await queueJobFn({
      type: payload.operationType,
      operationId: operation.id,
      scheduledActionId: fullSchedule.id,
      scheduledActionRunId: run.id,
      scheduledTrigger: options.advanceSchedule !== false ? 'due' : 'manual',
      userId: fullSchedule.userId,
      accountId: fullSchedule.accountId,
      authMethod: 'session',
      config: payload.jobConfig,
    });

    if (options.advanceSchedule !== false) {
      const isOnce = fullSchedule.scheduleType === 'once';
      const nextRunAt = isOnce ? null : calculateNextRunAt(fullSchedule, new Date());
      await prisma.scheduledAction.update({
        where: { id: fullSchedule.id },
        data: {
          status: 'active',
          nextRunAt,
          lastRunAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          failureCount: 0,
          lastError: null,
        },
      });
    }

    return { runId: run.id, operationId: operation.id };
  } catch (error) {
    await prisma.scheduledActionRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: error.message,
      },
    }).catch(() => {});

    await prisma.scheduledAction.update({
      where: { id: fullSchedule.id },
      data: {
        lockedAt: null,
        lockedBy: null,
        failureCount: { increment: 1 },
        lastError: error.message,
      },
    }).catch(() => {});

    throw error;
  }
}

async function processDueScheduledActions(queueJobFn, options = {}) {
  const now = new Date();
  const staleLock = new Date(now.getTime() - 10 * 60 * 1000);
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);

  const due = await prisma.scheduledAction.findMany({
    where: {
      status: 'active',
      nextRunAt: { lte: now },
      OR: [
        { lockedAt: null },
        { lockedAt: { lte: staleLock } },
      ],
    },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
  });

  const results = [];
  for (const item of due) {
    const claim = await prisma.scheduledAction.updateMany({
      where: {
        id: item.id,
        status: 'active',
        nextRunAt: { lte: now },
        OR: [
          { lockedAt: null },
          { lockedAt: { lte: staleLock } },
        ],
      },
      data: {
        lockedAt: now,
        lockedBy: schedulerId,
      },
    });

    if (claim.count !== 1) continue;

    const schedule = await prisma.scheduledAction.findUnique({
      where: { id: item.id },
      include: { user: true, account: true },
    });
    if (!schedule) continue;

    try {
      const result = await enqueueScheduledAction(schedule, queueJobFn, {
        scheduledFor: item.nextRunAt || now,
        advanceSchedule: true,
      });
      results.push({ scheduledActionId: item.id, ...result });
    } catch (error) {
      const failureCount = (schedule.failureCount || 0) + 1;
      await prisma.scheduledAction.update({
        where: { id: item.id },
        data: {
          status: failureCount > (schedule.maxRetries || 2) ? 'failed' : 'active',
          lockedAt: null,
          lockedBy: null,
          failureCount,
          lastError: error.message,
        },
      }).catch(() => {});
      results.push({ scheduledActionId: item.id, error: error.message });
    }
  }

  return results;
}

function startScheduledActionScheduler(queueJobFn, options = {}) {
  if (schedulerTimer || process.env.SCHEDULED_ACTIONS_DISABLED === 'true') return schedulerTimer;

  const intervalMs = Math.max(Number(options.intervalMs) || 30000, 5000);
  console.log(`📅 Scheduled action scheduler started (polling every ${Math.round(intervalMs / 1000)}s, id ${schedulerId})`);

  const tick = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      await processDueScheduledActions(queueJobFn, { limit: options.limit || 10 });
    } catch (error) {
      console.error('Scheduled action scheduler error:', error);
    } finally {
      schedulerRunning = false;
    }
  };

  schedulerTimer = setInterval(tick, intervalMs);
  schedulerTimer.unref?.();
  setTimeout(tick, 5000).unref?.();
  return schedulerTimer;
}

function stopScheduledActionScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export {
  createSchedulesFromRequest,
  decryptScheduledConfig,
  enqueueScheduledAction,
  processDueScheduledActions,
  publicSchedule,
  startScheduledActionScheduler,
  stopScheduledActionScheduler,
};
