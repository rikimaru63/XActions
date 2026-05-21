import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.js';
import {
  accountPauseMessage,
  listAccountsForUser,
  pauseActiveSchedulesForAccount,
  sanitizeAccount,
  setDefaultAccount,
  shouldPauseSchedulesForAccountStatus,
  upsertAccountForUser,
  verifySessionCookie,
} from '../services/accountStore.js';
import { decrypt, encrypt } from '../services/sessionCrypto.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const accounts = await listAccountsForUser(req.user);
    res.json({
      accounts,
      defaultAccountId: accounts.find((account) => account.isDefault)?.id || null,
    });
  } catch (error) {
    console.error('List accounts error:', error);
    res.status(500).json({ error: 'アカウント一覧を取得できませんでした。' });
  }
});

router.post('/', async (req, res) => {
  try {
    const sessionCookie = String(req.body.sessionCookie || '').trim();
    const skipVerify = process.env.NODE_ENV !== 'production'
      && (req.body.skipVerify === true || req.body.skipVerify === 'true');
    if (!sessionCookie) {
      return res.status(400).json({ error: 'X連携情報を入力してください。' });
    }

    if (!skipVerify) {
      const ok = await verifySessionCookie(sessionCookie);
      if (!ok) {
        return res.status(401).json({ error: 'X連携情報でログイン状態を確認できませんでした。' });
      }
    }

    const account = await upsertAccountForUser(req.user, {
      username: req.body.username,
      displayName: req.body.displayName,
      sessionCookie,
      isDefault: req.body.isDefault,
      status: 'active',
      lastVerifiedAt: skipVerify ? null : new Date(),
      error: null,
    });

    res.status(201).json({ account: sanitizeAccount(account) });
  } catch (error) {
    console.error('Create account error:', error);
    res.status(400).json({ error: error.message || 'アカウントを追加できませんでした。' });
  }
});

router.post('/:id/verify', async (req, res) => {
  try {
    const account = await prisma.xAccount.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: 'アカウントが見つかりません。' });

    const cookie = req.body.sessionCookie ? String(req.body.sessionCookie).trim() : null;
    const sessionCookie = cookie || decrypt(account.encryptedCookie);
    if (!sessionCookie) return res.status(400).json({ error: '保存済みのX連携情報を読み取れませんでした。' });
    const ok = await verifySessionCookie(sessionCookie);

    const updated = await prisma.xAccount.update({
      where: { id: account.id },
      data: {
        ...(cookie ? { encryptedCookie: encrypt(cookie) } : {}),
        status: ok ? 'active' : 'expired',
        lastVerifiedAt: new Date(),
        error: ok ? null : 'Xにログインできませんでした。',
      },
    });

    res.json({
      account: sanitizeAccount(updated),
      verified: ok,
      hasStoredCookie: true,
    });
  } catch (error) {
    console.error('Verify account error:', error);
    res.status(500).json({ error: 'アカウントを確認できませんでした。' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const account = await prisma.xAccount.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: 'アカウントが見つかりません。' });

    const data = {};
    if (typeof req.body.displayName === 'string') data.displayName = req.body.displayName.trim() || account.username;
    if (['active', 'expired', 'error', 'disabled'].includes(req.body.status)) data.status = req.body.status;
    if (typeof req.body.sessionCookie === 'string' && req.body.sessionCookie.trim()) {
      const ok = await verifySessionCookie(req.body.sessionCookie.trim());
      if (!ok) return res.status(401).json({ error: 'X連携情報でログイン状態を確認できませんでした。' });
      data.encryptedCookie = encrypt(req.body.sessionCookie.trim());
      data.status = 'active';
      data.lastVerifiedAt = new Date();
      data.error = null;
    }

    const updated = await prisma.xAccount.update({
      where: { id: account.id },
      data,
    });

    const schedulePause = shouldPauseSchedulesForAccountStatus(updated.status)
      ? await pauseActiveSchedulesForAccount(
          req.user.id,
          account.id,
          accountPauseMessage(updated.status)
        )
      : { count: 0 };

    if (req.body.isDefault === true || req.body.isDefault === 'true') {
      const defaulted = await setDefaultAccount(req.user.id, account.id);
      return res.json({
        account: sanitizeAccount(defaulted),
        pausedSchedules: schedulePause.count,
      });
    }

    res.json({
      account: sanitizeAccount(updated),
      pausedSchedules: schedulePause.count,
    });
  } catch (error) {
    console.error('Update account error:', error);
    res.status(400).json({ error: error.message || 'アカウントを更新できませんでした。' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const account = await prisma.xAccount.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!account) return res.status(404).json({ error: 'アカウントが見つかりません。' });

    await pauseActiveSchedulesForAccount(req.user.id, account.id, accountPauseMessage('deleted'));

    await prisma.xAccount.delete({ where: { id: account.id } });

    if (account.isDefault) {
      const next = await prisma.xAccount.findFirst({
        where: { userId: req.user.id, status: { not: 'disabled' } },
        orderBy: { createdAt: 'asc' },
      });
      if (next) await setDefaultAccount(req.user.id, next.id);
    }

    res.json({ deleted: true });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'アカウントを削除できませんでした。' });
  }
});

router.post('/:id/default', async (req, res) => {
  try {
    const account = await setDefaultAccount(req.user.id, req.params.id);
    res.json({ account: sanitizeAccount(account) });
  } catch (error) {
    console.error('Default account error:', error);
    res.status(404).json({ error: error.message || 'デフォルトにできませんでした。' });
  }
});

export default router;
