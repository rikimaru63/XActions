import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.js';
import { queueJob } from '../services/jobQueue.js';
import {
  assertScheduleAccountRunnable,
  createSchedulesFromRequest,
  enqueueScheduledAction,
  publicScheduledActionRun,
  publicSchedule,
} from '../services/scheduledActions.js';
import { calculateNextRunAt, normalizeScheduleInput } from '../services/scheduleUtils.js';
import { normalizeScheduleMaxRetries } from '../services/retryPolicy.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const where = { userId: req.user.id };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.featureId) where.featureId = String(req.query.featureId);
    if (req.query.accountId) where.accountId = String(req.query.accountId);
    if (req.query.accountIds) {
      const requestedAccountIds = String(req.query.accountIds)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      if (requestedAccountIds.length) {
        const accounts = await prisma.xAccount.findMany({
          where: {
            userId: req.user.id,
            id: { in: requestedAccountIds },
          },
          select: { id: true },
        });
        const allowedIds = accounts.map((account) => account.id);
        if (allowedIds.length !== new Set(requestedAccountIds).size) {
          return res.status(400).json({ error: '選択したXアカウントが見つかりません。' });
        }
        where.accountId = allowedIds.length === 1 ? allowedIds[0] : { in: allowedIds };
      }
    }

    const schedules = await prisma.scheduledAction.findMany({
      where,
      include: { account: true },
      orderBy: [{ status: 'asc' }, { nextRunAt: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
    });

    res.json({ schedules: schedules.map(publicSchedule) });
  } catch (error) {
    console.error('List scheduled actions error:', error);
    res.status(500).json({ error: '予約一覧を取得できませんでした。' });
  }
});

router.post('/', async (req, res) => {
  try {
    const schedules = await createSchedulesFromRequest(req.user, req.body);
    res.status(201).json({ schedules });
  } catch (error) {
    console.error('Create scheduled action error:', error);
    res.status(400).json({ error: error.message || '予約を作成できませんでした。' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { account: true },
    });
    if (!schedule) return res.status(404).json({ error: '予約が見つかりません。' });
    res.json({ schedule: publicSchedule(schedule) });
  } catch (error) {
    console.error('Get scheduled action error:', error);
    res.status(500).json({ error: '予約を取得できませんでした。' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { account: true },
    });
    if (!schedule) return res.status(404).json({ error: '予約が見つかりません。' });

    const data = {};
    if (typeof req.body.name === 'string') data.name = req.body.name.trim().slice(0, 80) || schedule.name;
    if (['active', 'paused', 'completed', 'failed'].includes(req.body.status)) data.status = req.body.status;
    if (typeof req.body.maxRetries !== 'undefined') data.maxRetries = normalizeScheduleMaxRetries(req.body.maxRetries, schedule.maxRetries);

    if (req.body.schedule) {
      const scheduleInput = normalizeScheduleInput(req.body.schedule);
      Object.assign(data, scheduleInput);
      data.nextRunAt = calculateNextRunAt({ ...schedule, ...scheduleInput });
      if (schedule.status !== 'paused') data.status = 'active';
      data.lastError = null;
    }

    if (data.status === 'active') {
      assertScheduleAccountRunnable(schedule);
    }

    const updated = await prisma.scheduledAction.update({
      where: { id: schedule.id },
      data,
      include: { account: true },
    });

    res.json({ schedule: publicSchedule(updated) });
  } catch (error) {
    console.error('Update scheduled action error:', error);
    res.status(400).json({ error: error.message || '予約を更新できませんでした。' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!schedule) return res.status(404).json({ error: '予約が見つかりません。' });

    await prisma.scheduledAction.delete({ where: { id: schedule.id } });
    res.json({ deleted: true });
  } catch (error) {
    console.error('Delete scheduled action error:', error);
    res.status(500).json({ error: '予約を削除できませんでした。' });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { status: 'paused', lockedAt: null, lockedBy: null },
    });
    if (schedule.count !== 1) return res.status(404).json({ error: '予約が見つかりません。' });
    const updated = await prisma.scheduledAction.findUnique({
      where: { id: req.params.id },
      include: { account: true },
    });
    res.json({ schedule: publicSchedule(updated) });
  } catch (error) {
    console.error('Pause scheduled action error:', error);
    res.status(500).json({ error: '予約を停止できませんでした。' });
  }
});

router.post('/:id/resume', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { account: true },
    });
    if (!schedule) return res.status(404).json({ error: '予約が見つかりません。' });
    assertScheduleAccountRunnable(schedule);

    const updated = await prisma.scheduledAction.update({
      where: { id: schedule.id },
      data: {
        status: 'active',
        nextRunAt: schedule.nextRunAt && schedule.nextRunAt > new Date()
          ? schedule.nextRunAt
          : calculateNextRunAt(schedule),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
      include: { account: true },
    });

    res.json({ schedule: publicSchedule(updated) });
  } catch (error) {
    console.error('Resume scheduled action error:', error);
    res.status(400).json({ error: error.message || '予約を再開できませんでした。' });
  }
});

router.post('/:id/run-now', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { user: true, account: true },
    });
    if (!schedule) return res.status(404).json({ error: '予約が見つかりません。' });

    const result = await enqueueScheduledAction(schedule, queueJob, {
      scheduledFor: new Date(),
      advanceSchedule: false,
    });

    res.json({ status: result.skipped ? 'skipped' : 'queued', ...result });
  } catch (error) {
    console.error('Run scheduled action error:', error);
    res.status(400).json({ error: error.message || '予約を実行できませんでした。' });
  }
});

router.get('/:id/runs', async (req, res) => {
  try {
    const schedule = await prisma.scheduledAction.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!schedule) return res.status(404).json({ error: '予約が見つかりません。' });

    const runs = await prisma.scheduledActionRun.findMany({
      where: { scheduledActionId: schedule.id },
      include: {
        operation: {
          include: {
            account: {
              select: {
                id: true,
                username: true,
                displayName: true,
                status: true,
                isDefault: true,
                lastVerifiedAt: true,
                lastUsedAt: true,
                error: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit) || 30, 1), 100),
    });

    res.json({
      runs: runs.map(publicScheduledActionRun),
    });
  } catch (error) {
    console.error('Scheduled action runs error:', error);
    res.status(500).json({ error: '予約履歴を取得できませんでした。' });
  }
});

export default router;
