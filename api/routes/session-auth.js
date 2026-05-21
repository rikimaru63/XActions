import express from 'express';
import { body, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';
import browserAutomation from '../services/browserAutomation.js';
import { decrypt, encrypt } from '../services/sessionCrypto.js';
import { upsertAccountForUser } from '../services/accountStore.js';

const router = express.Router();
const prisma = new PrismaClient();

// Save session cookie for browser automation
router.post('/save-session',
  authenticate,
  [
    body('sessionCookie').notEmpty().withMessage('Session cookie is required'),
    body('username').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { sessionCookie, username } = req.body;

      // Test the session cookie by attempting to authenticate
      const page = await browserAutomation.createPage(sessionCookie);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      await page.close();

      if (!isAuthenticated) {
        return res.status(401).json({ 
          error: 'Invalid session cookie - authentication failed' 
        });
      }

      // Save encrypted session cookie to user record
      const encryptedCookie = encrypt(sessionCookie);
      const updatedUser = await prisma.user.update({
        where: { id: req.user.id },
        data: {
          sessionCookie: encryptedCookie,
          twitterUsername: username || null,
          authMethod: 'session' // Track which method user prefers
        }
      });

      await upsertAccountForUser(updatedUser, {
        username: username || updatedUser.twitterUsername || updatedUser.username,
        encryptedCookie,
        isDefault: true,
        status: 'active',
        lastVerifiedAt: new Date(),
      });

      res.json({ 
        message: 'Session saved successfully',
        authMethod: 'session'
      });
    } catch (error) {
      console.error('Save session error:', error);
      res.status(500).json({ error: 'Failed to save session' });
    }
  }
);

// Remove session cookie (switch back to OAuth)
router.delete('/remove-session',
  authenticate,
  async (req, res) => {
    try {
      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          sessionCookie: null,
          authMethod: null
        }
      });

      res.json({ message: 'Session removed successfully' });
    } catch (error) {
      console.error('Remove session error:', error);
      res.status(500).json({ error: 'Failed to remove session' });
    }
  }
);

// Get current auth method
router.get('/auth-method',
  authenticate,
  async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          authMethod: true,
          twitterUsername: true,
          twitterAccessToken: true,
          sessionCookie: true
        }
      });

      const hasOAuth = !!user.twitterAccessToken;
      const hasSession = !!user.sessionCookie;

      res.json({
        authMethod: user.authMethod,
        hasOAuth,
        hasSession,
        username: user.twitterUsername
      });
    } catch (error) {
      console.error('Get auth method error:', error);
      res.status(500).json({ error: 'Failed to get auth method' });
    }
  }
);

// Helper function to get decrypted session cookie (for use in other services)
async function getDecryptedSessionCookie(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionCookie: true }
  });
  if (!user?.sessionCookie) return null;
  return decrypt(user.sessionCookie);
}

export default router;
export { getDecryptedSessionCookie, encrypt, decrypt };
