import express from 'express';
import { PrismaClient } from '@prisma/client';
import { body, validationResult } from 'express-validator';
import { authMiddleware } from '../middleware/auth.js';
import { queueJob } from '../services/jobQueue.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

function normalizeUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
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
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      if (!req.user.sessionCookie) {
        return res.status(400).json({ error: 'X account not connected - save a session cookie first' });
      }

      const targetUsername = normalizeUsername(req.body.targetUsername);
      const likeCount = Math.min(Math.max(Number(req.body.likeCount) || 0, 0), 10);
      const follow = req.body.follow === true || req.body.follow === 'true';
      const dmMessage = String(req.body.dmMessage || '').trim();
      const dryRun = req.body.dryRun !== false && req.body.dryRun !== 'false';
      const delayMs = Math.min(Math.max(Number(req.body.delayMs) || 3000, 2000), 60000);

      if (!targetUsername) {
        return res.status(400).json({ error: 'Target username is required' });
      }

      if (likeCount === 0 && !follow && !dmMessage) {
        return res.status(400).json({ error: 'Choose at least one action' });
      }

      const operation = await prisma.operation.create({
        data: {
          userId: req.user.id,
          type: 'targetEngage',
          status: 'pending',
          config: JSON.stringify({
            targetUsername,
            likeCount,
            follow,
            hasDmMessage: !!dmMessage,
            dryRun,
            delayMs,
          }),
        },
      });

      await queueJob({
        type: 'targetEngage',
        operationId: operation.id,
        userId: req.user.id,
        authMethod: 'session',
        config: {
          targetUsername,
          likeCount,
          follow,
          dmMessage,
          dryRun,
          delayMs,
        },
      });

      res.json({
        operationId: operation.id,
        status: 'queued',
        type: 'targetEngage',
        dryRun,
      });
    } catch (error) {
      console.error('Target action error:', error);
      res.status(500).json({ error: 'Failed to queue target action' });
    }
  }
);

export default router;
