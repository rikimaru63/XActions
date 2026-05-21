import express from 'express';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.js';
import { queueJob } from '../services/jobQueue.js';
import {
  getFeatureById,
  getFeatureHistoryTypes,
  getPublicFeatureCatalog,
} from '../config/features.js';
import {
  createActionPayload,
  sanitizeOperation,
} from '../services/consoleActions.js';
import { listAccountsForUser } from '../services/accountStore.js';
import { createSchedulesFromRequest } from '../services/scheduledActions.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

async function resolveExecutionAccounts(req, feature) {
  if (!feature.accountRequired) return [null];

  const accounts = await listAccountsForUser(req.user);
  const requested = Array.isArray(req.body.accountIds)
    ? req.body.accountIds
    : [req.body.accountId || accounts.find((account) => account.isDefault)?.id || accounts[0]?.id].filter(Boolean);

  if (!requested.length) {
    const error = new Error('X連携が必要です。設定からXアカウントを連携してください。');
    error.statusCode = 400;
    throw error;
  }

  const allowed = new Map(accounts.map((account) => [account.id, account]));
  for (const accountId of requested) {
    const account = allowed.get(accountId);
    if (!account) {
      const error = new Error('選択したXアカウントが見つかりません。');
      error.statusCode = 400;
      throw error;
    }
    if (account.status !== 'active') {
      const error = new Error(`@${account.username} は実行できる状態ではありません。`);
      error.statusCode = 400;
      throw error;
    }
  }

  return [...new Set(requested)];
}

router.get('/features', (_req, res) => {
  res.json(getPublicFeatureCatalog());
});

router.get('/accounts', async (req, res) => {
  const accounts = await listAccountsForUser(req.user);

  res.json({
    accounts,
    compatibilityMode: false,
    defaultAccountId: accounts[0]?.id || null,
    needsConnection: !accounts.length,
  });
});

router.get('/history', async (req, res) => {
  try {
    const { featureId, status } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const where = { userId: req.user.id };
    let sourceFeatureId = null;

    if (featureId) {
      const feature = getFeatureById(featureId);
      if (!feature) return res.status(404).json({ error: '機能が見つかりません。' });
      const types = getFeatureHistoryTypes(feature);
      if (types.length === 1) where.type = types[0];
      if (types.length > 1) where.type = { in: types };
      sourceFeatureId = feature.id;
    }

    if (status) where.status = String(status);

    const operations = await prisma.operation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: sourceFeatureId === 'sendDM' ? Math.min(limit * 3, 100) : limit,
    });

    const sanitized = operations
      .map(sanitizeOperation)
      .filter((operation) => {
        if (sourceFeatureId === 'sendDM') {
          return operation.config?.sourceFeatureId === 'sendDM' || operation.config?.hasDmMessage === true;
        }
        if (sourceFeatureId === 'targetEngage') {
          return operation.type === 'targetEngage';
        }
        return true;
      })
      .slice(0, limit);

    res.json({ operations: sanitized });
  } catch (error) {
    console.error('Console history error:', error);
    res.status(500).json({ error: '履歴を取得できませんでした。' });
  }
});

router.post('/actions/execute', async (req, res) => {
  try {
    const { featureId, config = {} } = req.body;
    const mode = req.body.mode === 'live' ? 'live' : 'dryRun';
    const feature = getFeatureById(featureId);

    if (!feature) return res.status(404).json({ error: '機能が見つかりません。' });
    if (feature.status !== 'available' || !feature.consoleAction) {
      return res.status(400).json({
        error: 'この機能はまだ新しいコンソールから実行できません。',
        page: feature.page || null,
        endpoint: feature.endpoint || null,
      });
    }

    if (mode === 'dryRun' && !feature.supportsDryRun) {
      return res.status(400).json({ error: 'この機能は確認のみには対応していません。実行を選んでください。' });
    }

    const payload = createActionPayload(feature, config, mode, req.user);
    const accountIds = await resolveExecutionAccounts(req, feature);
    const batchId = accountIds.length > 1 ? randomUUID() : null;
    const operations = [];

    for (const accountId of accountIds) {
      const operation = await prisma.operation.create({
        data: {
          userId: req.user.id,
          accountId,
          batchId,
          type: payload.operationType,
          status: 'pending',
          config: JSON.stringify(payload.operationConfig),
        },
      });

      await queueJob({
        type: payload.operationType,
        operationId: operation.id,
        userId: req.user.id,
        accountId,
        authMethod: 'session',
        config: payload.jobConfig,
      });

      operations.push({
        operationId: operation.id,
        accountId,
      });
    }

    res.json({
      operationId: operations[0]?.operationId || null,
      operations,
      batchId,
      featureId: feature.id,
      status: 'queued',
      mode,
    });
  } catch (error) {
    console.error('Console execute error:', error);
    res.status(error.statusCode || 400).json({ error: error.message || '実行を開始できませんでした。' });
  }
});

router.post('/actions/schedule', async (req, res) => {
  try {
    const schedules = await createSchedulesFromRequest(req.user, req.body);
    res.status(201).json({ schedules });
  } catch (error) {
    console.error('Console schedule error:', error);
    res.status(400).json({ error: error.message || '予約を作成できませんでした。' });
  }
});

export default router;
