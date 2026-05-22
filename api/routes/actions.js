import express from 'express';
import { body, validationResult } from 'express-validator';
import { authMiddleware } from '../middleware/auth.js';
import { getFeatureById } from '../config/features.js';
import { createActionPayload } from '../services/consoleActions.js';
import { queueConsoleOperations } from '../services/consoleExecution.js';
import { listAccountsForUser } from '../services/accountStore.js';
import {
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
} from '../services/accountSelection.js';

const router = express.Router();

router.use(authMiddleware);

function normalizeUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

async function resolveLegacyTargetAccounts(user, body) {
  const accounts = await listAccountsForUser(user);
  const requested = explicitAccountIdsFromBody(body);
  assertAccountSelectionLimit(requested);

  const accountIds = requested.length
    ? requested
    : accounts
        .filter((account) => account.status === 'active')
        .slice(0, 1)
        .map((account) => account.id);

  if (!accountIds.length) {
    const error = new Error(accounts.length
      ? '実行できるXアカウントがありません。連携情報を確認してください。'
      : 'Xアカウントを追加してください。');
    error.statusCode = 400;
    throw error;
  }

  const allowed = new Map(accounts.map((account) => [account.id, account]));
  for (const accountId of accountIds) {
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

  return accountIds;
}

router.post(
  '/target',
  [
    body('targetUsername').isString().trim().isLength({ min: 1, max: 30 }),
    body('likeCount').optional().isInt({ min: 0, max: 10 }),
    body('follow').optional().isBoolean(),
    body('dmMessage').optional({ checkFalsy: true }).isString().isLength({ max: 1000 }),
    body('dryRun').optional().isBoolean(),
    body('delayMs').optional().isInt({ min: 2000, max: 60000 }),
    body('accountId').optional().isString(),
    body('accountIds').optional().isArray({ max: 2 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const targetUsername = normalizeUsername(req.body.targetUsername);
      const likeCount = Math.min(Math.max(Number(req.body.likeCount) || 0, 0), 10);
      const follow = req.body.follow === true || req.body.follow === 'true';
      const dmMessage = String(req.body.dmMessage || '').trim();
      const dryRun = req.body.dryRun !== false && req.body.dryRun !== 'false';
      const delayMs = Math.min(Math.max(Number(req.body.delayMs) || 3000, 2000), 60000);

      if (!targetUsername) {
        return res.status(400).json({ error: '対象ユーザーを入力してください。' });
      }

      if (likeCount === 0 && !follow && !dmMessage) {
        return res.status(400).json({ error: '実行する内容を1つ以上選んでください。' });
      }

      const feature = getFeatureById('targetEngage');
      const mode = dryRun ? 'dryRun' : 'live';
      const payload = createActionPayload(feature, {
        targetUsername,
        likeCount,
        follow,
        dmMessage,
        delayMs,
      }, mode, req.user);
      const accountIds = await resolveLegacyTargetAccounts(req.user, req.body);
      const queued = await queueConsoleOperations({
        user: req.user,
        feature,
        payload,
        accountIds,
        mode,
        retryConfig: {
          targetUsername,
          likeCount,
          follow,
          dmMessage,
          delayMs,
        },
      });

      res.json({
        ...queued,
        status: 'queued',
        type: 'targetEngage',
        dryRun,
        mode,
      });
    } catch (error) {
      console.error('Target action error:', error);
      res.status(error.statusCode || 500).json({ error: error.message || '対象ユーザー操作を開始できませんでした。' });
    }
  }
);

export default router;
