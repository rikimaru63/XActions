import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.js';
import { queueJob } from '../services/jobQueue.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

// Send a DM
router.post('/send', async (req, res) => {
  try {
    if (!req.user.twitterAccessToken && !req.user.sessionCookie) {
      return res.status(400).json({ error: 'X連携が必要です。設定からXアカウントを連携してください。' });
    }

    const { username, message } = req.body;
    if (!username || !message) {
      return res.status(400).json({ error: '送信先と本文を入力してください。' });
    }

    const operation = await prisma.operation.create({
      data: {
        userId: req.user.id,
        type: 'sendDM',
        status: 'pending',
        config: JSON.stringify({
          username,
          hasMessage: true,
          messageLength: String(message).length,
        }),
      },
    });

    await queueJob({
      type: 'sendDM',
      operationId: operation.id,
      userId: req.user.id,
      authMethod: req.user.authMethod || 'oauth',
      config: { username, message, sessionCookie: req.user.sessionCookie },
    });

    res.json({ operationId: operation.id, status: 'queued', message: 'DM送信を予約しました。' });
  } catch (error) {
    console.error('Send DM error:', error);
    res.status(500).json({ error: 'DMを送信できませんでした。' });
  }
});

// Get conversations
router.get('/conversations', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const operation = await prisma.operation.create({
      data: {
        userId: req.user.id,
        type: 'getConversations',
        status: 'pending',
        config: JSON.stringify({ limit: parseInt(limit) }),
      },
    });

    await queueJob({
      type: 'getConversations',
      operationId: operation.id,
      userId: req.user.id,
      authMethod: req.user.authMethod || 'oauth',
      config: { limit: parseInt(limit), sessionCookie: req.user.sessionCookie },
    });

    res.json({ operationId: operation.id, status: 'queued', message: '会話一覧の取得を予約しました。' });
  } catch (error) {
    console.error('Conversations error:', error);
    res.status(500).json({ error: '会話一覧を取得できませんでした。' });
  }
});

// Export DMs
router.get('/export', async (req, res) => {
  try {
    const { format = 'json', limit = 100 } = req.query;

    const operation = await prisma.operation.create({
      data: {
        userId: req.user.id,
        type: 'exportDMs',
        status: 'pending',
        config: JSON.stringify({ format, limit: parseInt(limit) }),
      },
    });

    await queueJob({
      type: 'exportDMs',
      operationId: operation.id,
      userId: req.user.id,
      authMethod: req.user.authMethod || 'oauth',
      config: { format, limit: parseInt(limit), sessionCookie: req.user.sessionCookie },
    });

    res.json({ operationId: operation.id, status: 'queued', message: 'DMエクスポートを予約しました。' });
  } catch (error) {
    console.error('Export DMs error:', error);
    res.status(500).json({ error: 'DMをエクスポートできませんでした。' });
  }
});

export default router;
