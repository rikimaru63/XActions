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
  parseJson,
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

function configFromOperation(featureId, operationConfig = {}, overrideConfig = {}) {
  const config = { ...operationConfig, ...overrideConfig };

  if (featureId === 'sendDM') {
    return {
      username: overrideConfig.username || overrideConfig.targetUsername || operationConfig.targetUsername,
      message: overrideConfig.message || overrideConfig.dmMessage,
      delayMs: overrideConfig.delayMs ?? operationConfig.delayMs,
    };
  }

  if (featureId === 'targetEngage') {
    return {
      targetUsername: overrideConfig.targetUsername || operationConfig.targetUsername,
      likeCount: overrideConfig.likeCount ?? operationConfig.likeCount,
      follow: overrideConfig.follow ?? operationConfig.follow,
      dmMessage: overrideConfig.dmMessage || overrideConfig.message || '',
      delayMs: overrideConfig.delayMs ?? operationConfig.delayMs,
    };
  }

  if (featureId === 'likeTweet' || featureId === 'unlikeTweet') {
    return {
      tweetUrl: overrideConfig.tweetUrl || operationConfig.tweetUrl,
      tweetId: overrideConfig.tweetId || operationConfig.tweetId,
    };
  }

  if (featureId === 'autoLike') {
    return {
      query: overrideConfig.query ?? operationConfig.query,
      targetUsername: overrideConfig.targetUsername ?? operationConfig.targetUsername,
      maxLikes: overrideConfig.maxLikes ?? operationConfig.maxLikes,
    };
  }

  if (featureId === 'detectUnfollowers') {
    return {
      username: overrideConfig.username ?? operationConfig.username,
      maxUsers: overrideConfig.maxUsers ?? operationConfig.maxUsers,
    };
  }

  return config;
}

async function queueConsoleOperations({ user, feature, payload, accountIds, mode, retryOf = null }) {
  const batchId = accountIds.length > 1 || retryOf ? randomUUID() : null;
  let parentOperation = null;

  if (batchId) {
    parentOperation = await prisma.operation.create({
      data: {
        userId: user.id,
        batchId,
        type: payload.operationType,
        status: 'pending',
        config: JSON.stringify({
          ...payload.operationConfig,
          sourceFeatureId: feature.id,
          isBatch: true,
          retryOf,
          mode,
          accountIds: accountIds.filter(Boolean),
          childCount: accountIds.length,
        }),
      },
    });
  }

  const operations = [];
  for (const accountId of accountIds) {
    const operation = await prisma.operation.create({
      data: {
        userId: user.id,
        accountId,
        parentOperationId: parentOperation?.id || null,
        batchId,
        type: payload.operationType,
        status: 'pending',
        config: JSON.stringify(payload.operationConfig),
      },
    });

    await queueJob({
      type: payload.operationType,
      operationId: operation.id,
      userId: user.id,
      accountId,
      authMethod: 'session',
      config: payload.jobConfig,
    });

    operations.push({
      operationId: operation.id,
      accountId,
    });
  }

  return {
    operationId: parentOperation?.id || operations[0]?.operationId || null,
    parentOperationId: parentOperation?.id || null,
    operations,
    batchId,
  };
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

    const requestedAccountIds = String(req.query.accountIds || req.query.accountId || '')
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

    const operations = await prisma.operation.findMany({
      where,
      include: {
        account: {
          select: {
            id: true,
            username: true,
            displayName: true,
            status: true,
            isDefault: true,
          },
        },
        scheduledAction: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
        childOperations: {
          select: {
            id: true,
            accountId: true,
            type: true,
            status: true,
            error: true,
            config: true,
            result: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            account: {
              select: {
                id: true,
                username: true,
                displayName: true,
                status: true,
                isDefault: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
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
    const queued = await queueConsoleOperations({
      user: req.user,
      feature,
      payload,
      accountIds,
      mode,
    });

    res.json({
      ...queued,
      featureId: feature.id,
      status: 'queued',
      mode,
    });
  } catch (error) {
    console.error('Console execute error:', error);
    res.status(error.statusCode || 400).json({ error: error.message || '実行を開始できませんでした。' });
  }
});

router.post('/actions/retry-failed', async (req, res) => {
  try {
    const parentOperationId = req.body.parentOperationId || req.body.operationId;
    if (!parentOperationId) {
      return res.status(400).json({ error: '再実行する履歴を選択してください。' });
    }

    const parent = await prisma.operation.findFirst({
      where: { id: parentOperationId, userId: req.user.id },
      include: {
        childOperations: {
          where: { status: 'failed', accountId: { not: null } },
          include: { account: true },
        },
      },
    });

    if (!parent) return res.status(404).json({ error: '履歴が見つかりません。' });
    if (!parent.childOperations.length) {
      return res.status(400).json({ error: '再実行できる失敗アカウントがありません。' });
    }

    const parentConfig = parseJson(parent.config) || {};
    const feature = getFeatureById(req.body.featureId || parentConfig.sourceFeatureId);
    if (!feature) return res.status(404).json({ error: '機能が見つかりません。' });

    const failedAccounts = parent.childOperations
      .filter((operation) => operation.account?.status === 'active')
      .map((operation) => operation.accountId);

    if (!failedAccounts.length) {
      return res.status(400).json({ error: '失敗したXアカウントが実行できる状態ではありません。' });
    }

    const mode = req.body.mode === 'live' || parentConfig.mode === 'live' || parentConfig.dryRun === false ? 'live' : 'dryRun';
    const retryConfig = configFromOperation(feature.id, parentConfig, req.body.config || {});
    const payload = createActionPayload(feature, retryConfig, mode, req.user);
    const queued = await queueConsoleOperations({
      user: req.user,
      feature,
      payload,
      accountIds: [...new Set(failedAccounts)],
      mode,
      retryOf: parent.id,
    });

    res.json({
      ...queued,
      featureId: feature.id,
      status: 'queued',
      mode,
      retriedAccountCount: failedAccounts.length,
      retryOf: parent.id,
    });
  } catch (error) {
    console.error('Console retry failed accounts error:', error);
    res.status(error.statusCode || 400).json({ error: error.message || '失敗分を再実行できませんでした。' });
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
