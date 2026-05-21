import { PrismaClient } from '@prisma/client';
import browserAutomation from './browserAutomation.js';
import { decrypt, encrypt } from './sessionCrypto.js';

const prisma = new PrismaClient();

function normalizeUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

function sanitizeAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName || account.username,
    avatarUrl: account.avatarUrl || null,
    authMethod: account.authMethod,
    status: account.status,
    statusLabel: accountStatusLabel(account.status),
    isDefault: !!account.isDefault,
    lastVerifiedAt: account.lastVerifiedAt,
    lastUsedAt: account.lastUsedAt,
    error: account.error || null,
    compatibilityMode: !!account.compatibilityMode,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function accountStatusLabel(status) {
  return {
    active: '連携済み',
    expired: '期限切れ',
    error: '確認エラー',
    disabled: '停止中',
  }[status] || status || '-';
}

async function ensureSingleDefault(userId, accountId) {
  await prisma.xAccount.updateMany({
    where: { userId, id: { not: accountId } },
    data: { isDefault: false },
  });
}

async function ensureDefaultAccountForUser(user) {
  if (!user?.id || !user.sessionCookie) return null;

  const username = normalizeUsername(user.twitterUsername || user.username);
  if (!username) return null;

  const currentDefault = await prisma.xAccount.findFirst({
    where: { userId: user.id, isDefault: true },
  });

  const account = await prisma.xAccount.upsert({
    where: {
      userId_username: {
        userId: user.id,
        username,
      },
    },
    create: {
      userId: user.id,
      username,
      displayName: username,
      encryptedCookie: user.sessionCookie,
      authMethod: user.authMethod || 'session',
      status: 'active',
      isDefault: !currentDefault,
    },
    update: {
      encryptedCookie: user.sessionCookie,
      authMethod: user.authMethod || 'session',
      status: 'active',
      error: null,
      displayName: username,
    },
  });

  if (!currentDefault || account.isDefault) {
    await ensureSingleDefault(user.id, account.id);
  }

  return account;
}

async function listAccountsForUser(user) {
  await ensureDefaultAccountForUser(user);

  const accounts = await prisma.xAccount.findMany({
    where: { userId: user.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  return accounts.map(sanitizeAccount);
}

async function getAccountForUser(userId, accountId) {
  const where = { userId };

  if (accountId && accountId !== 'default') {
    return prisma.xAccount.findFirst({
      where: { ...where, id: accountId },
    });
  }

  const defaultAccount = await prisma.xAccount.findFirst({
    where: { ...where, status: { not: 'disabled' }, isDefault: true },
  });
  if (defaultAccount) return defaultAccount;

  return prisma.xAccount.findFirst({
    where: { ...where, status: { not: 'disabled' } },
    orderBy: { createdAt: 'asc' },
  });
}

async function getDecryptedAccountCookie(userId, accountId) {
  const account = await getAccountForUser(userId, accountId);
  if (accountId && !account) return null;

  if (account && account.status !== 'active') {
    return null;
  }

  if (account?.encryptedCookie) {
    const cookie = decrypt(account.encryptedCookie);
    if (cookie) {
      await prisma.xAccount.update({
        where: { id: account.id },
        data: { lastUsedAt: new Date(), error: null },
      }).catch(() => {});
      return cookie;
    }

    await prisma.xAccount.update({
      where: { id: account.id },
      data: {
        status: 'error',
        error: '保存済み cookie を復号できませんでした。',
      },
    }).catch(() => {});

    return null;
  }

  if (accountId || account) return null;

  // Compatibility fallback for users that still only have User.sessionCookie
  // and have not been migrated into XAccount yet.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionCookie: true },
  });

  return user?.sessionCookie ? decrypt(user.sessionCookie) : null;
}

async function verifySessionCookie(sessionCookie) {
  const page = await browserAutomation.createPage(sessionCookie);
  try {
    await browserAutomation.navigateToTwitter(page);
    return await browserAutomation.checkAuthentication(page);
  } finally {
    await page.close();
  }
}

async function upsertAccountForUser(user, input) {
  const username = normalizeUsername(input.username);
  const sessionCookie = String(input.sessionCookie || '').trim();
  if (!username) throw new Error('Xユーザー名を入力してください。');
  if (!sessionCookie && !input.encryptedCookie) throw new Error('session cookie を入力してください。');

  const encryptedCookie = input.encryptedCookie || encrypt(sessionCookie);
  const shouldDefault = input.isDefault === true || input.isDefault === 'true';
  const hasDefault = await prisma.xAccount.findFirst({
    where: { userId: user.id, isDefault: true },
  });

  const account = await prisma.xAccount.upsert({
    where: {
      userId_username: {
        userId: user.id,
        username,
      },
    },
    create: {
      userId: user.id,
      username,
      displayName: input.displayName || username,
      encryptedCookie,
      authMethod: 'session',
      status: input.status || 'active',
      isDefault: shouldDefault || !hasDefault,
      lastVerifiedAt: input.lastVerifiedAt || null,
      error: input.error || null,
    },
    update: {
      displayName: input.displayName || username,
      encryptedCookie,
      authMethod: 'session',
      status: input.status || 'active',
      error: input.error || null,
      ...(input.lastVerifiedAt ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
      ...(shouldDefault ? { isDefault: true } : {}),
    },
  });

  if (shouldDefault || !hasDefault || account.isDefault) {
    await ensureSingleDefault(user.id, account.id);
  }

  return account;
}

async function setDefaultAccount(userId, accountId) {
  const account = await prisma.xAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) throw new Error('アカウントが見つかりません。');

  await prisma.$transaction([
    prisma.xAccount.updateMany({
      where: { userId },
      data: { isDefault: false },
    }),
    prisma.xAccount.update({
      where: { id: accountId },
      data: { isDefault: true, status: account.status === 'disabled' ? 'active' : account.status },
    }),
  ]);

  return prisma.xAccount.findUnique({ where: { id: accountId } });
}

export {
  ensureDefaultAccountForUser,
  getAccountForUser,
  getDecryptedAccountCookie,
  listAccountsForUser,
  normalizeUsername,
  sanitizeAccount,
  setDefaultAccount,
  upsertAccountForUser,
  verifySessionCookie,
};
