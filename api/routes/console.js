import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.js';
import {
  getFeatureById,
  getFeatureHistoryTypes,
  getPublicFeatureCatalog,
} from '../config/features.js';
import {
  createActionPayload,
  operationMatchesFeatureHistory,
  parseJson,
  sanitizeOperation,
} from '../services/consoleActions.js';
import { buildAccountLiveReadiness, listAccountsForUser } from '../services/accountStore.js';
import {
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
  explicitAccountIdsFromQuery,
  operationAccountHistoryWhere,
} from '../services/accountSelection.js';
import { recoverRetryConfig } from '../services/consoleRetryConfig.js';
import { queueConsoleOperations } from '../services/consoleExecution.js';
import { createSchedulesFromRequest } from '../services/scheduledActions.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

async function resolveExecutionAccounts(req, feature) {
  if (!feature.accountRequired) return [null];

  const accounts = await listAccountsForUser(req.user);
  const requested = explicitAccountIdsFromBody(req.body);
  assertAccountSelectionLimit(requested);

  if (!requested.length) {
    const error = new Error(accounts.length
      ? '実行するXアカウントを選択してください。'
      : 'X連携が必要です。設定からXアカウントを連携してください。');
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

  return requested;
}

function configFromOperation(featureId, operationConfig = {}, overrideConfig = {}) {
  const config = recoverRetryConfig(operationConfig, overrideConfig);

  if (featureId === 'sendDM') {
    return {
      username: config.username || config.targetUsername,
      message: config.message || config.dmMessage,
      delayMs: config.delayMs,
    };
  }

  if (featureId === 'targetEngage') {
    return {
      targetUsername: config.targetUsername,
      likeCount: config.likeCount,
      follow: config.follow,
      dmMessage: config.dmMessage || config.message || '',
      delayMs: config.delayMs,
    };
  }

  if (featureId === 'likeTweet' || featureId === 'unlikeTweet') {
    return {
      tweetUrl: config.tweetUrl,
      tweetId: config.tweetId,
    };
  }

  if (featureId === 'autoLike') {
    return {
      query: config.query,
      targetUsername: config.targetUsername,
      maxLikes: config.maxLikes,
    };
  }

  if (featureId === 'detectUnfollowers') {
    return {
      username: config.username,
      maxUsers: config.maxUsers,
    };
  }

  return config;
}

function addHistoryAnd(where, clause) {
  where.AND = [...(where.AND || []), clause];
}

function addFeatureHistoryConfigFilter(where, featureId) {
  if (!featureId) return;

  if (featureId === 'sendDM') {
    addHistoryAnd(where, {
      OR: [
        { type: 'sendDM' },
        { config: { contains: '"sourceFeatureId":"sendDM"' } },
        { config: { contains: '"hasMessage":true' } },
        { config: { contains: '"hasDmMessage":true' } },
      ],
    });
    return;
  }

  addHistoryAnd(where, {
    OR: [
      { config: { contains: `"sourceFeatureId":"${featureId}"` } },
      { config: null },
      { config: { not: { contains: '"sourceFeatureId":' } } },
    ],
  });
}

router.get('/features', (_req, res) => {
  res.json(getPublicFeatureCatalog());
});

router.get('/accounts', async (req, res) => {
  const accounts = await listAccountsForUser(req.user);
  const liveReadiness = buildAccountLiveReadiness(accounts);

  res.json({
    accounts,
    liveReadiness,
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
      addFeatureHistoryConfigFilter(where, sourceFeatureId);
    }

    if (status) where.status = String(status);

    const requestedAccountIds = explicitAccountIdsFromQuery(req.query);

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
      Object.assign(where, operationAccountHistoryWhere(allowedIds));
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
      take: limit,
    });

    const sanitized = operations
      .map(sanitizeOperation)
      .filter((operation) => operationMatchesFeatureHistory(operation, sourceFeatureId))
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
        error: 'この機能はこの画面から実行できません。',
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
      retryConfig: config,
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
    assertAccountSelectionLimit([...new Set(failedAccounts)]);

    if (!failedAccounts.length) {
      return res.status(400).json({ error: '失敗したアカウントが実行できる状態ではありません。' });
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
      retryConfig,
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
